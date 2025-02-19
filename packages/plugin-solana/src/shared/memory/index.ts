import { IAgentRuntime, Memory, UUID, IMemoryManager } from "@elizaos/core";
import { BaseMemoryManager } from "./BaseMemoryManager";
import { MemoryQueryOptions } from "../types/memory";

export * from "./SQLiteMemoryManager";
export * from "./MemoryManagerFactory";

// Re-export types from base
export { Transaction, BaseContent } from "../types/base";

export class MemoryManager extends BaseMemoryManager {
    private adapter: any;

    constructor(options: { runtime: IAgentRuntime; tableName: string; adapter: any }) {
        super(options.runtime, { tableName: options.tableName });
        this.adapter = options.adapter;
    }

    async initialize(): Promise<void> {
        await this.adapter.initialize();
    }

    protected async createMemoryInternal(memory: Memory, unique?: boolean): Promise<void> {
        await this.adapter.createMemory(memory, unique);
    }

    protected async getMemoriesInternal(options: MemoryQueryOptions): Promise<Memory[]> {
        return this.adapter.getMemories(options);
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        return this.adapter.addEmbeddingToMemory(memory);
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        return this.adapter.getCachedEmbeddings(content);
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]> {
        return this.adapter.getMemoriesByRoomIds(params);
    }

    async searchMemoriesByEmbedding(embedding: number[], opts: { match_threshold?: number; count?: number; roomId: UUID; unique?: boolean }): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, opts);
    }

    async removeMemory(id: UUID): Promise<void> {
        await this.adapter.removeMemory(id);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.adapter.removeAllMemories(roomId);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.adapter.countMemories(roomId, unique);
    }

    async shutdown(): Promise<void> {
        await this.adapter.shutdown();
    }

    async beginTransaction(): Promise<void> {
        await this.adapter.beginTransaction();
    }

    async commitTransaction(): Promise<void> {
        await this.adapter.commitTransaction();
    }

    async rollbackTransaction(): Promise<void> {
        await this.adapter.rollbackTransaction();
    }

    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        // Implement uniqueness check logic here
        return false; // Placeholder return
    }

    protected async beginTransactionInternal(): Promise<void> {
        // Implement transaction start logic here
    }

    protected async commitTransactionInternal(): Promise<void> {
        // Implement transaction commit logic here
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        // Implement transaction rollback logic here
    }

    protected async searchMemoriesByEmbeddingInternal(
        embedding: number[],
        opts: { 
            match_threshold?: number; 
            count?: number; 
            roomId: UUID; 
            unique?: boolean;
            query?: string;
        }
    ): Promise<Memory[]> {
        // Implement embedding search logic here
        return []; // Placeholder return
    }

    protected async searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]> {
        // Implement text search logic here
        return []; // Placeholder return
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryInternal(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        await this.adapter.updateMemoryInternal(memory);
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.adapter.removeMemoryInternal(id);
    }
} 