import { IMemoryManager as CoreMemoryManager, Memory, UUID, IAgentRuntime } from "@elizaos/core";

export class ExtendedMemoryManager implements CoreMemoryManager {
    constructor(
        private coreManager: CoreMemoryManager,
        private memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>>
    ) {}

    // Event handling methods
    on(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
    }

    off(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
    }

    // Delegate core methods
    get runtime() { return this.coreManager.runtime; }
    get tableName() { return this.coreManager.tableName; }
    
    async initialize() { return this.coreManager.initialize(); }
    async shutdown() { return this.coreManager.shutdown(); }
    async addEmbeddingToMemory(memory: Memory) { return this.coreManager.addEmbeddingToMemory(memory); }
    async getMemories(opts: any) { return this.coreManager.getMemories(opts); }
    async getMemoriesWithPagination(opts: any) { return this.coreManager.getMemoriesWithPagination(opts); }
    async getCachedEmbeddings(content: string) { return this.coreManager.getCachedEmbeddings(content); }
    async getMemoryById(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemory(id: UUID) { return this.coreManager.getMemoryById(id); }
    async getMemoriesByRoomIds(params: any) { return this.coreManager.getMemoriesByRoomIds(params); }
    async searchMemoriesByEmbedding(embedding: number[], opts: any) { return this.coreManager.searchMemoriesByEmbedding(embedding, opts); }
    async createMemory(memory: Memory, unique?: boolean) { return this.coreManager.createMemory(memory, unique); }
    async removeMemory(memoryId: UUID) { return this.coreManager.removeMemory(memoryId); }
    async removeAllMemories(roomId: UUID) { return this.coreManager.removeAllMemories(roomId); }
    async countMemories(roomId: UUID, unique?: boolean) { return this.coreManager.countMemories(roomId, unique); }
    async beginTransaction() { return this.coreManager.beginTransaction(); }
    async commitTransaction() { return this.coreManager.commitTransaction(); }
    async rollbackTransaction() { return this.coreManager.rollbackTransaction(); }
    async resyncDomainMemory() { return this.coreManager.resyncDomainMemory(); }
} 