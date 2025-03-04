// packages/plugin-solana/src/shared/memory/ExtendedMemoryManager.ts

import { Memory, UUID, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { BaseContent, IMemoryManager, IExtendedMemoryManager } from "../types/base.ts";
import { MemoryEvent } from "../types/memory-events.ts";
import { MemorySyncManager } from "./MemorySyncManager";
import { CONVERSATION_ROOM_ID } from "../utils/messageUtils";

export class ExtendedMemoryManager implements IExtendedMemoryManager {
    constructor(
        private coreManager: IMemoryManager,
        private memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>>,
        private memorySyncManager: MemorySyncManager
    ) {}

    // Implement standardized subscription methods
    public subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
        
        // Also subscribe to the core manager
        this.coreManager.subscribeToMemory(type, callback);
    }

    public unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
        
        // Also unsubscribe from the core manager
        this.coreManager.unsubscribeFromMemory(type, callback);
    }

    // Backward compatibility methods
    /** @deprecated Use subscribeToMemory instead */
    public on(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribeToMemory(type, callback);
    }

    /** @deprecated Use unsubscribeFromMemory instead */
    public off(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribeFromMemory(type, callback);
    }

    /** @deprecated Use subscribeToMemory instead */
    public subscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribeToMemory(type, callback);
    }

    /** @deprecated Use unsubscribeFromMemory instead */
    public unsubscribe(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribeFromMemory(type, callback);
    }

    /** @deprecated Use broadcastMemoryChange instead */
    public async emit(type: string, memory: Memory): Promise<void> {
        const event: MemoryEvent = {
            type,
            content: memory.content as BaseContent,
            roomId: memory.roomId,
            agentId: memory.agentId,
            timestamp: Date.now(),
            memory
        };
        
        // Notify subscribers
        const subscribers = this.memorySubscriptions.get(type);
        if (subscribers) {
            for (const callback of subscribers) {
                try {
                    await callback(memory);
                } catch (error) {
                    elizaLogger.error(`Error in memory subscriber callback:`, error);
                }
            }
        }
    }

    // Memory operations
    async createMemory(memory: Memory): Promise<void> {
        await this.coreManager.createMemory(memory);
        
        // Notify local subscribers
        await this.emit("memory_created", memory);
        
        if (memory.content && typeof memory.content.type === 'string') {
            await this.emit(memory.content.type, memory);
        }

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "create",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    async updateMemory(memory: Memory): Promise<void> {
        await this.coreManager.updateMemory(memory);
        
        // Notify local subscribers
        await this.emit("memory_updated", memory);
        
        if (memory.content && typeof memory.content.type === 'string') {
            await this.emit(memory.content.type, memory);
        }

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "update",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        const memory = await this.getMemoryById(memoryId);
        if (!memory) return;

        await this.coreManager.removeMemory(memoryId);
        
        // Notify local subscribers
        await this.emit("memory_deleted", memory);

        // Sync to other processes
        await this.memorySyncManager.syncMemory({
            type: "memory_sync",
            operation: "delete",
            memory,
            timestamp: Date.now(),
            processId: process.pid
        });
    }

    // Delegate core methods
    get runtime() { return this.coreManager.runtime; }
    get tableName() { return this.coreManager.tableName; }
    
    async initialize() { return this.coreManager.initialize(); }
    async shutdown() { return this.coreManager.shutdown(); }
    async addEmbeddingToMemory(memory: Memory) { return this.coreManager.addEmbeddingToMemory(memory); }
    async getMemories(opts: any): Promise<Memory[]> {
        // Get memories from core manager
        const memories = await this.coreManager.getMemories({
            roomId: opts.roomId,
            count: opts.count,
            unique: opts.unique,
            start: opts.start,
            end: opts.end
        });
        
        // Apply filter if provided
        return opts.filter ? this.filterMemories(memories, opts.filter) : memories;
    }

    // Add proper getMemoriesWithFilters implementation
    async getMemoriesWithFilters(opts: any): Promise<Memory[]> {
        elizaLogger.debug("ExtendedMemoryManager.getMemoriesWithFilters called", { 
            filter: JSON.stringify(opts.filter),
            roomId: opts.roomId,
            count: opts.count
        });
        
        // Check if it's a wallet registration query - look for wallet_registration in filter
        const isWalletRegistrationQuery = 
            opts.filter && (
                // Check for content.type being wallet_registration
                (opts.filter["content.type"] && 
                 (opts.filter["content.type"] === "wallet_registration" ||
                  opts.filter["content.type"] === "pending_wallet_registration")) ||
                // Or check for _treasuryOperation flag
                opts._treasuryOperation === true || 
                opts.filter._treasuryOperation === true
            );
        
        // For treasury operations, ensure we never reject the special conversation room ID
        if (isWalletRegistrationQuery) {
            // If it's a wallet registration and roomId is the special conversation ID or missing,
            // use the special conversation room ID to ensure wallet lookups work properly
            if (!opts.roomId || opts.roomId === CONVERSATION_ROOM_ID) {
                opts.roomId = CONVERSATION_ROOM_ID;
                elizaLogger.info("Using conversation room ID for wallet registration query in ExtendedMemoryManager", {
                    filter: JSON.stringify(opts.filter),
                    roomId: opts.roomId
                });
            }
        } 
        // Handle non-treasury operations with regular roomId validation
        else if (!opts.roomId) {
            if (process.env.DISABLE_EMBEDDINGS === 'true') {
                elizaLogger.warn("Missing roomId in ExtendedMemoryManager.getMemoriesWithFilters with embeddings disabled, returning empty array");
                return [];
            }
            // For non-treasury operations with missing roomId and embeddings enabled, 
            // we'd normally error, but we'll let the core manager handle it
        }
        
        // Get base memories using standard getMemories
        const memories = await this.coreManager.getMemories({
            roomId: opts.roomId,
            count: opts.count || 50, // Use higher default count to ensure we find all matches
            unique: opts.unique,
            start: opts.start,
            end: opts.end
        });
        
        // Apply the filter and sort if provided
        let results = opts.filter ? this.filterMemories(memories, opts.filter) : memories;
        
        // Apply sorting if specified
        if (opts.sortBy) {
            results = this.sortMemories(results, opts.sortBy, opts.sortDirection);
        }
        
        // Limit to requested count
        if (opts.count && results.length > opts.count) {
            results = results.slice(0, opts.count);
        }
        
        elizaLogger.debug(`ExtendedMemoryManager.getMemoriesWithFilters returning ${results.length} results`, {
            firstResultType: results.length > 0 ? results[0]?.content?.type : 'none',
            filter: JSON.stringify(opts.filter)
        });
        
        return results;
    }
    
    // Helper method for sorting memories
    private sortMemories(memories: Memory[], sortBy: string, sortDirection: string = 'desc'): Memory[] {
        return [...memories].sort((a, b) => {
            const aValue = this.getNestedProperty(a, sortBy);
            const bValue = this.getNestedProperty(b, sortBy);
            
            if (aValue === undefined && bValue === undefined) return 0;
            if (aValue === undefined) return sortDirection === 'desc' ? 1 : -1;
            if (bValue === undefined) return sortDirection === 'desc' ? -1 : 1;
            
            // Sort order
            const compareResult = aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
            return sortDirection === 'desc' ? -compareResult : compareResult;
        });
    }
    
    // Helper to get nested property using dot notation (e.g., "content.updatedAt")
    private getNestedProperty(obj: any, path: string): any {
        return path.split('.').reduce((prev, curr) => 
            prev && prev[curr] !== undefined ? prev[curr] : undefined, obj);
    }

    async getMemoriesWithPagination(opts: any) { return this.coreManager.getMemoriesWithPagination(opts); }
    async getCachedEmbeddings(content: string) { return this.coreManager.getCachedEmbeddings(content); }
    async getMemoryById(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemory(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemoriesByRoomIds(params: any) { return this.coreManager.getMemoriesByRoomIds(params); }
    async searchMemoriesByEmbedding(embedding: number[], opts: any) { return this.coreManager.searchMemoriesByEmbedding(embedding, opts); }
    async removeAllMemories(roomId: UUID) { return this.coreManager.removeAllMemories(roomId); }
    async countMemories(roomId: UUID, unique?: boolean) { return this.coreManager.countMemories(roomId, unique); }
    async beginTransaction() { return this.coreManager.beginTransaction(); }
    async commitTransaction() { return this.coreManager.commitTransaction(); }
    async rollbackTransaction() { return this.coreManager.rollbackTransaction(); }
    async resyncDomainMemory() { return this.coreManager.resyncDomainMemory(); }

    // Add missing methods
    isInTransaction(): boolean { return (this.coreManager as any).isInTransaction?.() ?? false; }
    getTransactionLevel(): number { return (this.coreManager as any).getTransactionLevel?.() ?? 0; }
    async getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]> {
        return this.coreManager.getMemories(options);
    }
    async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        return this.coreManager.getMemoryById(id);
    }
    async removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void> {
        // Basic implementation - can be enhanced later
        const memories = await this.coreManager.getMemories({ 
            roomId: this.runtime.agentId,
            count: 1000
        });
        for (const memory of memories) {
            if (memory.content.type === filter.type) {
                await this.coreManager.removeMemory(memory.id);
            }
        }
    }

    async updateMemoryWithVersion(id: UUID, update: Partial<Memory>, expectedVersion: number): Promise<boolean> {
        const current = await this.getMemoryWithLock(id);
        if (!current || !current.content || current.content.version !== expectedVersion) {
            return false;
        }

        const updatedMemory: Memory = {
            ...current,
            ...update,
            content: {
                ...current.content,
                ...update.content,
                version: expectedVersion + 1,
                versionTimestamp: Date.now()
            }
        };

        await this.updateMemory(updatedMemory);
        return true;
    }

    async getLatestVersionWithLock(id: UUID): Promise<Memory | null> {
        return this.getMemoryWithLock(id);
    }

    /**
     * Internal method to filter memories based on provided criteria
     */
    private filterMemories(memories: Memory[], filter?: Record<string, unknown>): Memory[] {
        if (!filter) return memories;
        
        return memories.filter(memory => {
            for (const [key, value] of Object.entries(filter)) {
                // Handle nested paths (e.g., "content.type")
                const path = key.split('.');
                let current: any = memory;
                
                // Traverse the path
                for (const segment of path) {
                    if (current === null || current === undefined) return false;
                    current = current[segment];
                }
                
                // Compare the value
                if (current !== value) return false;
            }
            return true;
        });
    }
} 