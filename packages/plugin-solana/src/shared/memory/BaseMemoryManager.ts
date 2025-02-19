import {
    AgentType,
    AgentState,
    AgentCapability,
    AgentMessage,
    BaseContent,
    CharacterName,
    DAOEventType,
    DAOEvent,
    Transaction,
    REQUIRED_MEMORY_TYPES,
    UNIQUE_MEMORY_TYPES,
    isUniqueMemoryType,
    isVersionedMemoryType,
    MemoryMetadata
} from "../types/base";
import { UUID, IAgentRuntime, elizaLogger, stringToUuid, ServiceType, Service, IMemoryManager } from "@elizaos/core";
import { Memory, MemorySubscription } from "../types/memory-types";
import { MemoryQueryOptions } from "../types/memory";
import { MessageBroker } from "../MessageBroker";
import { MemoryEvent } from "../types/memory-events";
import { EmbeddingService } from "../services/EmbeddingService";
import * as Database from "better-sqlite3";
import { EventEmitter } from "events";
import { getMemoryRoom } from "../constants";
import { MemorySyncManager } from "./MemorySyncManager";

export interface PaginatedResult<T> {
    items: T[];
    hasMore: boolean;
    nextCursor?: UUID;
    lastTimestamp?: number;
}

export interface PaginationOptions {
    // Primary pagination method (only one should be used)
    cursor?: UUID;        // For cursor-based pagination (preferred)
    timestamp?: number;   // For time-based filtering (for real-time updates)
    
    // Required parameters
    limit: number;        // Required number of items per page
    
    // Optional filters
    startTime?: number;   // Filter items after this timestamp
    endTime?: number;     // Filter items before this timestamp
    
    // Deprecated - will be removed
    offset?: number;      // Legacy offset-based pagination
}

export interface MemoryManagerOptions {
    useEmbeddings?: boolean;
    tableName: string;
}

/**
 * Abstract base class for memory management implementations.
 * Provides common functionality and defines the contract for concrete implementations.
 */
export abstract class BaseMemoryManager implements IMemoryManager {
    public runtime: IAgentRuntime;
    protected _tableName: string;
    protected readonly DEFAULT_PAGE_SIZE = 50;
    protected readonly MAX_PAGE_SIZE = 100;
    protected useEmbeddings: boolean;
    protected _isInTransaction: boolean = false;
    protected messageBroker: MessageBroker;
    protected memorySyncManager: MemorySyncManager;
    protected memorySubscriptions: Map<string, Set<MemorySubscription["callback"]>>;
    protected embeddingService: EmbeddingService;
    protected lastSyncTimestamp: number = 0;

    constructor(runtime: IAgentRuntime, options: MemoryManagerOptions) {
        this.runtime = runtime;
        this._tableName = options.tableName;
        this.useEmbeddings = options.useEmbeddings ?? false;
        this.messageBroker = MessageBroker.getInstance();
        this.memorySyncManager = MemorySyncManager.getInstance();
        this.memorySubscriptions = new Map();
        this.embeddingService = EmbeddingService.getInstance(runtime, {
            enabled: options.useEmbeddings
        });
        this.setupCrossProcessEvents();
        this.setupMemorySyncHandlers();
        this.lastSyncTimestamp = Date.now();
    }

    private setupCrossProcessEvents(): void {
        this.messageBroker.subscribe("memory_created", (event: MemoryEvent) => {
            if (event.agentId !== this.runtime.agentId) {
                this.notifySubscribers(event);
            }
        });
    }

    private setupMemorySyncHandlers(): void {
        // Listen for memory sync events
        this.memorySyncManager.onMemorySynced(async (memory: Memory) => {
            // Notify subscribers
            const subscribers = this.memorySubscriptions.get((memory.content as BaseContent).type);
            if (subscribers) {
                for (const callback of subscribers) {
                    try {
                        await callback(memory);
                    } catch (error) {
                        elizaLogger.error("Error in memory sync subscriber:", error);
                    }
                }
            }
        });

        this.memorySyncManager.onMemoryDeleted(async (memoryId: UUID) => {
            // Handle memory deletion
            elizaLogger.debug(`Memory ${memoryId} was deleted in another process`);
        });
    }

    private async notifySubscribers(event: MemoryEvent): Promise<void> {
        const subscribers = this.memorySubscriptions.get(event.content.type);
        if (!subscribers) return;

        const memory: Memory = {
            id: event.content.id,
            content: event.content,
            roomId: event.roomId,
            agentId: event.agentId,
            userId: event.agentId
        };

        for (const callback of subscribers) {
            try {
                await callback(memory);
            } catch (error) {
                elizaLogger.error("Error in memory subscriber callback:", error);
            }
        }
    }

    protected async broadcastMemoryChange(event: MemoryEvent): Promise<void> {
        await this.messageBroker.broadcast(event);
    }

    get tableName(): string {
        return this._tableName;
    }

    get isInTransaction(): boolean {
        return this._isInTransaction;
    }

    /**
     * Centralized uniqueness check for memory creation
     */
    protected async validateAndPrepareMemory(memory: Memory, unique?: boolean): Promise<Memory> {
        const content = memory.content as BaseContent;

        // If memory type should be unique, validate uniqueness constraints
        if (isUniqueMemoryType(content.type)) {
            // If ID is provided, respect it - otherwise generate one
            if (!content.id) {
                content.id = stringToUuid(`${content.type}-${Date.now().toString()}`);
            }

            // Check uniqueness constraints
            const exists = await this.checkUniqueness(memory);
            if (exists) {
                throw new Error(`Memory of type ${content.type} with constraints already exists`);
            }
        } else if (!content.id) {
            // For non-unique types, always generate new ID
            content.id = stringToUuid(`${content.type}-${Date.now().toString()}`);
        }

        // Handle versioning if needed
        if (isVersionedMemoryType(content.type) && content.id) {
            const previousVersions = await this.getMemories({
                roomId: memory.roomId,
                count: 1
            });
            
            const previousVersion = previousVersions.find(m => 
                (m.content as BaseContent).type === content.type && 
                (m.content as BaseContent).id === content.id
            );

            if (previousVersion) {
                const prevContent = previousVersion.content as BaseContent;
                const prevMetadata = prevContent.metadata as MemoryMetadata || {};
                const currentMetadata = content.metadata as MemoryMetadata || {};

                content.metadata = {
                    ...currentMetadata,
                    version: (prevMetadata.version || 0) + 1,
                    previousVersion: prevMetadata.version,
                    versionTimestamp: Date.now(),
                    versionReason: currentMetadata.versionReason || 'Update'
                };
            }
        }

        return {
            ...memory,
            content
        };
    }

    /**
     * Abstract method for uniqueness checking - must be implemented by concrete classes
     */
    protected abstract checkUniqueness(memory: Memory): Promise<boolean>;

    /**
     * Creates a memory with proper validation and uniqueness checks
     */
    async createMemory(memory: Memory, unique?: boolean): Promise<void> {
        await this.createMemoryInternal(memory, unique);
        
        // Broadcast memory creation for sync
        this.messageBroker.emit("memory_created", memory);
    }

    /**
     * Internal method to be implemented by concrete classes for actual memory creation
     */
    protected abstract createMemoryInternal(memory: Memory, unique?: boolean): Promise<void>;

    /**
     * Helper method to create a memory with proper IDs
     */
    protected createMemoryWithIds(
        content: any,
        options: {
            /** Override the default room ID (defaults to agent's room) */
            roomId?: UUID;
            /** Override the default user ID (defaults to agent ID) */
            userId?: UUID;
            /** Whether this memory belongs to a specific room vs the agent's room */
            isRoomSpecific?: boolean;
            /** Whether this memory should be unique */
            unique?: boolean;
        } = {}
    ): Memory {
        // Get the correct room based on memory type
        const effectiveRoomId = getMemoryRoom(content.type, this.runtime.agentId);

        return {
            id: content.id,
            roomId: effectiveRoomId,
            // User ID can be overridden, but defaults to agent ID
            userId: options.userId || this.runtime.agentId,
            // Agent ID is always the creator's ID
            agentId: this.runtime.agentId,
            content
        };
    }

    /**
     * Helper method to determine if a memory belongs to the agent's room
     */
    protected isAgentRoomMemory(memory: Memory): boolean {
        return memory.roomId === this.runtime.agentId;
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
            limit = this.DEFAULT_PAGE_SIZE,
            startTime,
            endTime
        } = options;

        // Enforce pagination limits
        const pageSize = Math.min(limit, this.MAX_PAGE_SIZE);

        // Get one extra item to determine if there are more pages
        const memories = await this.runtime.databaseAdapter.getMemories({
            roomId,
            count: pageSize + 1,
            unique: true,
            start: startTime,
            end: endTime,
            tableName: this._tableName,
            agentId: this.runtime.agentId
        });

        // Check if we got an extra item (indicates there are more pages)
        const hasMore = memories.length > pageSize;
        const items = hasMore ? memories.slice(0, pageSize) : memories;

        // Get the cursor for the next page
        const nextCursor = hasMore ? items[items.length - 1].id : undefined;

        return {
            items,
            hasMore,
            nextCursor
        };
    }

    /**
     * Original getMemories method for backward compatibility
     */
    async getMemories(opts: { roomId: UUID; count?: number; unique?: boolean; start?: number; end?: number; }): Promise<Memory[]> {
        const { items } = await this.getMemoriesWithPagination({
            roomId: opts.roomId,
            limit: opts.count || this.DEFAULT_PAGE_SIZE,
            startTime: opts.start,
            endTime: opts.end
        });
        return items;
    }

    /**
     * Internal method to be implemented by concrete classes for memory retrieval
     */
    protected abstract getMemoriesInternal(options: MemoryQueryOptions & {
        lastId?: UUID;
        timestamp?: number;
        offset?: number;
        limit?: number;
    }): Promise<Memory[]>;

    async beginTransaction(): Promise<void> {
        if (this._isInTransaction) {
            elizaLogger.warn("Transaction already in progress, skipping nested transaction");
            return;
        }
        this._isInTransaction = true;
        await this.beginTransactionInternal();
    }

    async commitTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            elizaLogger.warn("No active transaction to commit");
            return;
        }
        await this.commitTransactionInternal();
        this._isInTransaction = false;
    }

    async rollbackTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            elizaLogger.warn("No active transaction to rollback");
            return;
        }
        await this.rollbackTransactionInternal();
        this._isInTransaction = false;
    }

    protected abstract beginTransactionInternal(): Promise<void>;
    protected abstract commitTransactionInternal(): Promise<void>;
    protected abstract rollbackTransactionInternal(): Promise<void>;

    abstract initialize(): Promise<void>;
    abstract getMemoryById(id: UUID): Promise<Memory | null>;
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        if (!memory.content.text) {
            return memory;
        }

        const embedding = await this.embeddingService.getEmbedding(memory.content.text);
        return embedding ? { ...memory, embedding } : memory;
    }
    abstract getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    abstract getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]>;
    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
            query?: string;  // Original query text for fallback
        }
    ): Promise<Memory[]> {
        if (!this.embeddingService.isEnabled()) {
            elizaLogger.info("Embeddings disabled, falling back to text search");
            return this.searchMemoriesByText(opts.roomId, (memory) => {
                // Simple text similarity fallback
                const similarity = this.calculateTextSimilarity(
                    memory.content.text || "",
                    opts.query || ""
                );
                return similarity >= (opts.match_threshold || 0.5);
            }, opts.count);
        }

        return this.searchMemoriesByEmbeddingInternal(embedding, opts);
    }
    abstract removeMemory(id: UUID): Promise<void>;
    abstract removeAllMemories(roomId: UUID): Promise<void>;
    abstract countMemories(roomId: UUID, unique?: boolean): Promise<number>;
    abstract shutdown(): Promise<void>;

    public subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
    }

    public unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
    }

    protected abstract searchMemoriesByEmbeddingInternal(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
            query?: string;
        }
    ): Promise<Memory[]>;

    protected abstract searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]>;

    private calculateTextSimilarity(text1: string, text2: string): number {
        // Simple Jaccard similarity as fallback
        const words1 = new Set(text1.toLowerCase().split(/\s+/));
        const words2 = new Set(text2.toLowerCase().split(/\s+/));
        
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        
        return intersection.size / union.size;
    }

    /**
     * Syncs domain memory by fetching all relevant records since last sync
     */
    public async resyncDomainMemory(): Promise<void> {
        const memories = await this.getMemoriesInternal({
            domain: this.runtime.agentId,
            timestamp: this.lastSyncTimestamp,
            types: Object.values(REQUIRED_MEMORY_TYPES).flat()
        });

        for (const memory of memories) {
            await this.processMemory(memory);
        }

        this.lastSyncTimestamp = Date.now();
    }

    /**
     * Process a single memory for sync
     */
    protected async processMemory(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        
        // Broadcast memory created event to ensure all subscribers are notified
        await this.broadcastMemoryChange({
            type: "memory_created",
            content,
            roomId: memory.roomId,
            agentId: this.runtime.agentId,
            timestamp: Date.now()
        });
    }

    async getMemory(id: UUID): Promise<Memory | null> {
        // First check recent memories from sync manager
        const recentMemory = this.memorySyncManager.getRecentMemory(id);
        if (recentMemory) {
            return recentMemory;
        }

        // If not found in recent memories, check database
        return this.getMemoryInternal(id);
    }

    protected abstract getMemoryInternal(id: UUID): Promise<Memory | null>;
    protected abstract updateMemoryInternal(memory: Memory): Promise<void>;
    protected abstract removeMemoryInternal(id: UUID): Promise<void>;
} 