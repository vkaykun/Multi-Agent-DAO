import { embed, getEmbeddingZeroVector } from "./embedding.ts";
import elizaLogger from "./logger.ts";
import type {
    IAgentRuntime,
    IMemoryManager,
    Memory,
    UUID,
} from "./types.ts";

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
            // Validate existing embedding - NOTE: Expected dimension is 384 for BGE embeddings
            if (!Array.isArray(memory.embedding) || memory.embedding.length !== 384) {
                elizaLogger.error("Invalid existing embedding:", {
                    isArray: Array.isArray(memory.embedding),
                    length: Array.isArray(memory.embedding) ? memory.embedding.length : 'not an array',
                    expected: 384
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
            if (!Array.isArray(embedding) || embedding.length !== 1536) {
                elizaLogger.error("Invalid generated embedding:", {
                    isArray: Array.isArray(embedding),
                    length: Array.isArray(embedding) ? embedding.length : 'not an array'
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

    async getCachedEmbeddings(content: string): Promise<
        {
            embedding: number[];
            levenshtein_score: number;
        }[]
    > {
        return await this.runtime.databaseAdapter.getCachedEmbeddings({
            query_table_name: this.tableName,
            query_threshold: 2,
            query_input: content,
            query_field_name: "content",
            query_field_sub_name: "text",
            query_match_count: 10,
        });
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
        const {
            match_threshold = defaultMatchThreshold,
            count = defaultMatchCount,
            roomId,
            unique,
        } = opts;

        // Check if embeddings are disabled
        const disableEmbeddings = process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";
        
        // If embeddings are disabled, just return recent memories instead of trying semantic search
        if (disableEmbeddings) {
            elizaLogger.debug("Embeddings disabled, skipping semantic search and returning recent memories");
            
            // Handle the case where roomId might be missing
            let effectiveRoomId = roomId;
            if (!effectiveRoomId) {
                // Try to use a default room ID - first check for a global room constant
                const globalRoomId = (global as any).__GLOBAL_ROOM_ID as UUID;
                
                if (globalRoomId) {
                    effectiveRoomId = globalRoomId;
                    elizaLogger.debug("Using global room ID as fallback for missing roomId");
                } else {
                    // Fall back to the agent's ID as the room ID
                    effectiveRoomId = this.runtime.agentId;
                    elizaLogger.debug("Using agent ID as fallback for missing roomId");
                }
                
                elizaLogger.info("Using fallback roomId in searchMemoriesByEmbedding:", effectiveRoomId);
            }
            
            // Use getMemories as a fallback
            try {
                return await this.runtime.databaseAdapter.getMemories({
                    roomId: effectiveRoomId,
                    count,
                    unique: !!unique,
                    tableName: this.tableName,
                    agentId: this.runtime.agentId
                });
            } catch (error) {
                elizaLogger.error("Error in fallback getMemories:", error);
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

    async getMemoriesByRoomIds(params: { roomIds: UUID[], limit?: number; }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.getMemoriesByRoomIds({
            tableName: this.tableName,
            agentId: this.runtime.agentId,
            roomIds: params.roomIds,
            limit: params.limit
        });
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