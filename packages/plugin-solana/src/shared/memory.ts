import { IMemoryManager, Memory, IAgentRuntime, UUID, Service, ServiceType } from "@elizaos/core";
import { IDatabaseAdapter } from "@elizaos/core";

export class MemoryManager implements IMemoryManager {
    constructor(private config: {
        runtime: IAgentRuntime;
        tableName: string;
        adapter: IDatabaseAdapter;
    }) {}

    get runtime(): IAgentRuntime {
        return this.config.runtime;
    }

    get tableName(): string {
        return this.config.tableName;
    }

    async initialize(): Promise<void> {
        // No initialization needed for base memory manager
    }

    async shutdown(): Promise<void> {
        // No shutdown needed for base memory manager
    }

    async getMemory(id: UUID): Promise<Memory | null> {
        return this.config.adapter.getMemoryById(id);
    }

    async resyncDomainMemory(): Promise<void> {
        // No domain memory sync needed for base memory manager
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        if (!memory.content.text) return memory;

        try {
            const service = this.runtime.getService(ServiceType.TEXT_GENERATION) as Service & { getEmbeddingResponse(text: string): Promise<number[]> };
            const embedding = await service?.getEmbeddingResponse(memory.content.text);

            if (embedding) {
                return {
                    ...memory,
                    embedding
                };
            }
        } catch (error) {
            console.error("Error generating embedding:", error);
        }

        return memory;
    }

    async getMemories(opts: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        return this.config.adapter.getMemories({
            ...opts,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        const memories = await this.config.adapter.getMemoriesByIds([id], this.tableName);
        return memories[0] || null;
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]> {
        return this.config.adapter.getMemoriesByRoomIds({
            ...params,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            unique?: boolean;
        }
    ): Promise<Memory[]> {
        return this.config.adapter.searchMemories({
            tableName: this.tableName,
            agentId: this.runtime.agentId,
            roomId: opts.roomId,
            embedding,
            match_threshold: opts.match_threshold || 0.8,
            match_count: opts.count || 10,
            unique: opts.unique || false
        });
    }

    async createMemory(memory: Memory, unique?: boolean): Promise<void> {
        const memoryWithEmbedding = await this.addEmbeddingToMemory(memory);
        await this.config.adapter.createMemory(memoryWithEmbedding, this.tableName, unique);
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        await this.config.adapter.removeMemory(memoryId, this.tableName);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.config.adapter.removeAllMemories(roomId, this.tableName);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.config.adapter.countMemories(roomId, unique, this.tableName);
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        return this.config.adapter.getCachedEmbeddings({
            query_table_name: this.tableName,
            query_threshold: 3,
            query_input: content,
            query_field_name: "content",
            query_field_sub_name: "text",
            query_match_count: 10
        });
    }

    async beginTransaction(): Promise<void> {
        await (this.config.adapter as any).beginTransaction();
    }

    async commitTransaction(): Promise<void> {
        await (this.config.adapter as any).commitTransaction();
    }

    async rollbackTransaction(): Promise<void> {
        await (this.config.adapter as any).rollbackTransaction();
    }

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
        return this.config.adapter.getMemoriesWithPagination({
            ...options,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });
    }
} 