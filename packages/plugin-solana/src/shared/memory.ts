// shared/memory.ts

import { embed, getEmbeddingZeroVector } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import type {
    IAgentRuntime,
    IMemoryManager,
    Memory,
    UUID,
} from "@elizaos/core";
import { ROOM_IDS } from "./constants.ts";
import { STANDARD_VECTOR_DIMENSION } from "./utils/embedding-validator";

const defaultMatchThreshold = 0.1;
const defaultMatchCount = 10;

/**
 * Manage memories in the database.
 */
export class MemoryManager implements IMemoryManager {
    /**
     * The AgentRuntime instance associated with this manager.
     */
    runtime: IAgentRuntime;

    /**
     * The name of the database table this manager operates on.
     */
    tableName: string;

    protected memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>> = new Map();

    /**
     * Constructs a new MemoryManager instance.
     * @param opts Options for the manager.
     * @param opts.tableName The name of the table this manager will operate on.
     * @param opts.runtime The AgentRuntime instance associated with this manager.
     */
    constructor(opts: { tableName: string; runtime: IAgentRuntime }) {
        this.runtime = opts.runtime;
        this.tableName = opts.tableName;
    }

    async initialize(): Promise<void> {
        // Core MemoryManager doesn't need initialization
    }

    async shutdown(): Promise<void> {
        // Core MemoryManager doesn't need shutdown
    }

    /**
     * Adds an embedding vector to a memory object if one doesn't already exist.
     * The embedding is generated from the memory's text content using the runtime's
     * embedding model. If the memory has no text content, an error is thrown.
     *
     * @param memory The memory object to add an embedding to
     * @returns The memory object with an embedding vector added
     * @throws Error if the memory content is empty or if embedding generation fails
     */
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // Check if embeddings are globally disabled
        const disableEmbeddings = process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";
        
        // If embeddings are disabled, just add a zero vector and skip all other processing
        if (disableEmbeddings) {
            memory.embedding = getEmbeddingZeroVector();
            return memory;
        }
        
        // Return early if embedding already exists
        if (memory.embedding) {
            // Validate existing embedding - Use STANDARD_VECTOR_DIMENSION (1536) for OpenAI embeddings
            if (!Array.isArray(memory.embedding) || memory.embedding.length !== STANDARD_VECTOR_DIMENSION) {
                elizaLogger.error("Invalid existing embedding:", {
                    isArray: Array.isArray(memory.embedding),
                    length: Array.isArray(memory.embedding) ? memory.embedding.length : 'not an array',
                    expected: STANDARD_VECTOR_DIMENSION
                });
                // Use a zero vector instead of throwing
                elizaLogger.warn("Replacing invalid embedding with zero vector");
                memory.embedding = getEmbeddingZeroVector();
            }
            return memory;
        }

        const memoryText = memory.content.text;

        // Validate memory has text content
        if (!memoryText) {
            elizaLogger.warn("Cannot generate embedding: Memory content is empty, using zero vector");
            memory.embedding = getEmbeddingZeroVector();
            return memory;
        }

        try {
            // Generate embedding from text content
            const embedding = await embed(this.runtime, memoryText);
            
            // Validate embedding
            if (!Array.isArray(embedding) || embedding.length !== STANDARD_VECTOR_DIMENSION) {
                elizaLogger.error("Invalid generated embedding:", {
                    isArray: Array.isArray(embedding),
                    length: Array.isArray(embedding) ? embedding.length : 'not an array',
                    expected: STANDARD_VECTOR_DIMENSION
                });
                // Use a zero vector instead of throwing
                elizaLogger.warn("Using zero vector due to invalid embedding format");
                memory.embedding = getEmbeddingZeroVector();
                return memory;
            }
            
            memory.embedding = embedding;
        } catch (error) {
            elizaLogger.error("Failed to generate embedding, using zero vector as fallback:", error);
            // Use a zero vector instead of propagating the error
            memory.embedding = getEmbeddingZeroVector();
            
            // Add a flag to indicate this is a fallback embedding
            // Use memory.content for storing metadata since Memory doesn't have a top-level metadata field
            const currentMetadata = memory.content.metadata || {};
            
            // Add embeddingFallback flag to content metadata (avoid using spread operator)
            memory.content.metadata = Object.assign({}, currentMetadata, {
                embeddingFallback: true,
                embeddingError: error instanceof Error ? error.message : 'Unknown error'
            });
        }

        return memory;
    }

    /**
     * Retrieves a list of memories by user IDs, with optional deduplication.
     * @param opts Options including user IDs, count, and uniqueness.
     * @param opts.roomId The room ID to retrieve memories for.
     * @param opts.count The number of memories to retrieve.
     * @param opts.unique Whether to retrieve unique memories only.
     * @returns A Promise resolving to an array of Memory objects.
     */
    async getMemories({
        roomId,
        count = 10,
        unique = true,
        start,
        end,
    }: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.getMemories({
            roomId,
            count,
            unique,
            tableName: this.tableName,
            agentId: this.runtime.agentId,
            start,
            end,
        });
    }

    /**
     * Safely truncates content for Levenshtein distance calculation to prevent database errors
     * @param content The content string to potentially truncate
     * @param maxLength Maximum length for Levenshtein calculation (defaults to 250 to be safe)
     * @returns The truncated content string
     */
    private truncateForLevenshtein(content: string, maxLength: number = 250): string {
        if (!content) return '';
        
        // If content is within limits, return as is
        if (content.length <= maxLength) return content;
        
        // Truncate and add indicator that it was truncated
        const truncated = content.substring(0, maxLength - 3) + '...';
        elizaLogger.debug(`Truncated content for Levenshtein from ${content.length} to ${truncated.length} characters`);
        return truncated;
    }

    async getCachedEmbeddings(content: string): Promise<
        {
            embedding: number[];
            levenshtein_score: number;
        }[]
    > {
        try {
            // CRITICAL FIX: Truncate content to prevent Levenshtein errors
            // PostgreSQL's levenshtein function has a limit of 255 characters
            const truncatedContent = this.truncateForLevenshtein(content);
            
            return await this.runtime.databaseAdapter.getCachedEmbeddings({
                query_table_name: this.tableName,
                query_threshold: 2,
                query_input: truncatedContent,
                query_field_name: "content",
                query_field_sub_name: "text",
                query_match_count: 10,
            });
        } catch (error) {
            // Handle the error gracefully and log
            elizaLogger.error("Error in getCachedEmbeddings, returning empty result:", {
                error: error instanceof Error ? error.message : String(error),
                contentLength: content ? content.length : 0
            });
            
            // Return empty array as fallback
            return [];
        }
    }

    /**
     * Searches for memories similar to a given embedding vector.
     * @param embedding The embedding vector to search with.
     * @param opts Options including match threshold, count, user IDs, and uniqueness.
     * @param opts.match_threshold The similarity threshold for matching memories.
     * @param opts.count The maximum number of memories to retrieve.
     * @param opts.roomId The room ID to retrieve memories for.
     * @param opts.unique Whether to retrieve unique memories only.
     * @returns A Promise resolving to an array of Memory objects that match the embedding.
     */
    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
        }
    ): Promise<Memory[]> {
        // Only consider completely missing roomId as invalid, don't override valid UUIDs
        if (!opts.roomId) {
            const correctRoomId = ROOM_IDS.DAO;
            elizaLogger.warn(`Missing roomId in searchMemoriesByEmbedding, using DAO room ID: ${correctRoomId}`, {
                providedRoomId: opts.roomId || "undefined",
                correctRoomId
            });
            opts.roomId = correctRoomId;
        }

        const {
            match_threshold = defaultMatchThreshold,
            count = defaultMatchCount,
            roomId,
            unique,
        } = opts;

        // Check if embeddings are disabled
        const disableEmbeddings = process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";
        
        // If embeddings are disabled, use an improved fallback method
        if (disableEmbeddings) {
            elizaLogger.debug("Embeddings disabled, using enhanced fallback retrieval for most recent messages");
            
            // Handle the case where roomId might be missing (although we fixed this above)
            if (!roomId) {
                elizaLogger.warn("Missing roomId parameter in searchMemoriesByEmbedding when embeddings are disabled");
                return []; // Return empty array instead of throwing
            }
            
            // IMPROVED FALLBACK: Get the most recent messages first with proper sorting
            try {
                elizaLogger.info("Using enhanced getMemoriesByRoomIds fallback with improved parameters");
                
                // Get a larger set of memories to filter from
                const memories = await this.runtime.databaseAdapter.getMemoriesByRoomIds({
                    roomIds: [roomId],
                    limit: Math.max(30, (count || 10) * 2), // Get more than needed to allow for filtering
                    tableName: this.tableName,
                    agentId: this.runtime.agentId
                });
                
                // Add comment explaining that we're not using the unique parameter
                elizaLogger.debug("Note: Unique filter parameter not passed to adapter, will filter manually if needed");
                
                // Add explicit sort direction to bypass adapter interface limitation
                // Sort by timestamp manually since we can't specify sortDirection at adapter level
                const sortedMemories = [...memories].sort((a, b) => {
                    const aTime = a?.content?.createdAt || a?.content?.timestamp || 0;
                    const bTime = b?.content?.createdAt || b?.content?.timestamp || 0;
                    return Number(bTime) - Number(aTime); // Newest first (descending order)
                });
                
                elizaLogger.info(`Retrieved ${sortedMemories.length} recent memories for fallback context`);
                
                // Filter out system messages and errors for cleaner context
                const filteredMemories = sortedMemories.filter(memory => {
                    const type = memory?.content?.type;
                    // Skip system and error messages
                    if (type === 'system_message' || 
                        type === 'error_message' || 
                        type === 'internal_error') {
                        return false;
                    }
                    
                    // Skip empty content
                    if (!memory.content || !memory.content.text) {
                        return false;
                    }
                    
                    return true;
                });
                
                elizaLogger.info(`Filtered to ${filteredMemories.length} relevant conversation messages`);
                
                // Take only what was needed (with a few extra for context)
                const finalMemories = filteredMemories.slice(0, Math.min(filteredMemories.length, count + 5));
                
                elizaLogger.info(`Returning ${finalMemories.length} memories from enhanced fallback`);
                return finalMemories;
            } catch (error) {
                elizaLogger.error("Error in enhanced fallback retrieval:", error);
                return []; // Return empty array on error
            }
        }

        const result = await this.runtime.databaseAdapter.searchMemories({
            tableName: this.tableName,
            roomId,
            agentId: this.runtime.agentId,
            embedding: embedding,
            match_threshold: match_threshold,
            match_count: count,
            unique: !!unique,
        });

        return result;
    }

    /**
     * Creates a new memory in the database, with an option to check for similarity before insertion.
     * @param memory The memory object to create.
     * @param unique Whether to check for similarity before insertion.
     * @returns A Promise that resolves when the operation completes.
     */
    async createMemory(memory: Memory, unique = false): Promise<void> {
        // TODO: check memory.agentId == this.runtime.agentId

        const existingMessage =
            await this.runtime.databaseAdapter.getMemoryById(memory.id);

        if (existingMessage) {
            elizaLogger.debug("Memory already exists, skipping");
            return;
        }

        elizaLogger.log("Creating Memory", memory.id, memory.content.text);

        await this.runtime.databaseAdapter.createMemory(
            memory,
            this.tableName,
            unique
        );
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[], limit?: number; sortDirection?: "asc" | "desc" }): Promise<Memory[]> {
        // Add logging for tracing
        elizaLogger.debug("getMemoriesByRoomIds called with params:", {
            roomIds: params.roomIds.join(', '),
            limit: params.limit,
            sortDirection: params.sortDirection
        });
        
        // NOTE: We're not passing sortDirection to the adapter since it might not support it
        // We'll sort the results manually after retrieval
        // Most adapters already return in DESC order by default (newest first)
        const result = await this.runtime.databaseAdapter.getMemoriesByRoomIds({
            tableName: this.tableName,
            agentId: this.runtime.agentId,
            roomIds: params.roomIds,
            limit: params.limit
        });
        
        // ENHANCED: Normalize timestamps for consistent sorting
        // This ensures all memories have valid timestamps for reliable sorting
        const normalizedResult = result.map(memory => {
            if (!memory.content) {
                memory.content = {
                    text: '',
                    type: 'unknown',
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
            }
            
            // Ensure createdAt exists and is a number
            if (!memory.content.createdAt) {
                // Try to use other timestamp fields if available
                memory.content.createdAt = (memory.content.timestamp as number) || 
                                           memory.createdAt || 
                                           Date.now();
            }
            
            // Convert string timestamps to numbers
            if (typeof memory.content.createdAt === 'string') {
                memory.content.createdAt = parseInt(memory.content.createdAt, 10) || Date.now();
            }
            
            return memory;
        });
        
        // ENHANCED: More robust sorting with logging to help debug
        elizaLogger.debug(`Sorting ${normalizedResult.length} memories with direction: ${params.sortDirection || 'default asc'}`);
        
        // If sortDirection is specified as "desc", sort manually (newest first)
        if (params.sortDirection === "desc") {
            const sorted = normalizedResult.sort((a, b) => {
                const aTime = (a?.content?.createdAt as number) || 0;
                const bTime = (b?.content?.createdAt as number) || 0;
                return Number(bTime) - Number(aTime); // Newest first
            });
            
            // Log the first few timestamps to verify sorting
            if (sorted.length > 0) {
                elizaLogger.debug("Sorted DESC order timestamps (first 3 and last 3):", {
                    first: sorted.slice(0, Math.min(3, sorted.length)).map(m => ({
                        id: m.id?.toString().substring(0, 8),
                        timestamp: m.content?.createdAt,
                        date: new Date(m.content?.createdAt as number || 0).toISOString()
                    })),
                    last: sorted.slice(-Math.min(3, sorted.length)).map(m => ({
                        id: m.id?.toString().substring(0, 8),
                        timestamp: m.content?.createdAt,
                        date: new Date(m.content?.createdAt as number || 0).toISOString()
                    }))
                });
            }
            
            return sorted;
        }
        
        // If sortDirection is "asc" or not specified, sort ascending (oldest first)
        const sorted = normalizedResult.sort((a, b) => {
            const aTime = (a?.content?.createdAt as number) || 0;
            const bTime = (b?.content?.createdAt as number) || 0;
            return Number(aTime) - Number(bTime); // Oldest first
        });
        
        // Log the first few timestamps to verify sorting
        if (sorted.length > 0) {
            elizaLogger.debug("Sorted ASC order timestamps (first 3 and last 3):", {
                first: sorted.slice(0, Math.min(3, sorted.length)).map(m => ({
                    id: m.id?.toString().substring(0, 8),
                    timestamp: m.content?.createdAt,
                    date: new Date(m.content?.createdAt as number || 0).toISOString()
                })),
                last: sorted.slice(-Math.min(3, sorted.length)).map(m => ({
                    id: m.id?.toString().substring(0, 8),
                    timestamp: m.content?.createdAt,
                    date: new Date(m.content?.createdAt as number || 0).toISOString()
                }))
            });
        }
        
        return sorted;
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        const result = await this.runtime.databaseAdapter.getMemoryById(id);
        if (result && result.agentId !== this.runtime.agentId) return null;
        return result;
    }

    /**
     * Removes a memory from the database by its ID.
     * @param memoryId The ID of the memory to remove.
     * @returns A Promise that resolves when the operation completes.
     */
    async removeMemory(memoryId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeMemory(
            memoryId,
            this.tableName
        );
    }

    /**
     * Removes all memories associated with a set of user IDs.
     * @param roomId The room ID to remove memories for.
     * @returns A Promise that resolves when the operation completes.
     */
    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeAllMemories(
            roomId,
            this.tableName
        );
    }

    /**
     * Counts the number of memories associated with a set of user IDs, with an option for uniqueness.
     * @param roomId The room ID to count memories for.
     * @param unique Whether to count unique memories only.
     * @returns A Promise resolving to the count of memories.
     */
    async countMemories(roomId: UUID, unique = true): Promise<number> {
        return await this.runtime.databaseAdapter.countMemories(
            roomId,
            unique,
            this.tableName
        );
    }

    async beginTransaction(): Promise<void> {
        await this.runtime.databaseAdapter.beginTransaction();
    }

    async commitTransaction(): Promise<void> {
        await this.runtime.databaseAdapter.commitTransaction();
    }

    async rollbackTransaction(): Promise<void> {
        await this.runtime.databaseAdapter.rollbackTransaction();
    }

    async resyncDomainMemory(): Promise<void> {
        // Core MemoryManager doesn't need to sync domain memory
        // This is implemented by specialized managers
    }

    /**
     * Retrieves memories with cursor-based pagination
     */
    async getMemoriesWithPagination(options: {
        roomId: UUID;
        limit?: number;
        cursor?: UUID;
        startTime?: number;
        endTime?: number;
    }): Promise<{
        items: Memory[];
        hasMore: boolean;
        nextCursor?: UUID;
    }> {
        const {
            roomId,
            limit = 50,
            startTime,
            endTime
        } = options;

        // Get one extra item to determine if there are more pages
        const memories = await this.runtime.databaseAdapter.getMemories({
            roomId,
            count: limit + 1,
            unique: true,
            start: startTime,
            end: endTime,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });

        // Check if we got an extra item (indicates there are more pages)
        const hasMore = memories.length > limit;
        const items = hasMore ? memories.slice(0, limit) : memories;

        // Get the cursor for the next page
        const nextCursor = hasMore ? items[items.length - 1].id : undefined;

        return {
            items,
            hasMore,
            nextCursor
        };
    }

    /**
     * Retrieves a memory by its ID. Alias for getMemoryById.
     */
    async getMemory(id: UUID): Promise<Memory | null> {
        return this.getMemoryById(id);
    }

    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
    }

    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
    }

    async updateMemory(memory: Memory): Promise<void> {
        await this.runtime.databaseAdapter.updateMemory(memory, this.tableName);
    }

    async updateMemoryWithVersion(id: UUID, update: Partial<Memory>, expectedVersion: number): Promise<boolean> {
        const current = await this.getMemoryById(id);
        if (!current || !current.content || current.content.version !== expectedVersion) {
            return false;
        }
        await this.updateMemory({
            ...current,
            ...update,
            content: {
                ...current.content,
                ...update.content,
                version: expectedVersion + 1,
                versionTimestamp: Date.now()
            }
        });
        return true;
    }

    async getLatestVersionWithLock(id: UUID): Promise<Memory | null> {
        return this.getMemoryById(id);
    }
}