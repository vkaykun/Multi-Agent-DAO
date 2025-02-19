import { UUID, Memory, IAgentRuntime } from "./types";

export interface IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;
    initialize(): Promise<void>;
    createMemory(memory: Memory, unique?: boolean): Promise<void>;
    getMemories(options: { roomId: UUID; count?: number; unique?: boolean }): Promise<Memory[]>;
    getMemoriesWithPagination(options: { 
        roomId: UUID; 
        limit?: number; 
        cursor?: UUID; 
        startTime?: number;
        endTime?: number;
    }): Promise<{
        items: Memory[];
        hasMore: boolean;
        nextCursor?: UUID;
    }>;
    getMemoryById(id: UUID): Promise<Memory | null>;
    getMemoryByFilter(filter: Partial<Memory>): Promise<Memory | null>;
    addEmbeddingToMemory(memory: Memory): Promise<Memory>;
    getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]>;
    searchMemoriesByEmbedding(embedding: number[], opts: { match_threshold?: number; count?: number; roomId: UUID; unique?: boolean }): Promise<Memory[]>;
    removeMemory(id: UUID): Promise<void>;
    removeAllMemories(roomId: UUID): Promise<void>;
    countMemories(roomId: UUID, unique?: boolean): Promise<number>;
    shutdown(): Promise<void>;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    resyncDomainMemory(): Promise<void>;
    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
} 