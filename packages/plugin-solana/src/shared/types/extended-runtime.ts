import { 
    IAgentRuntime as CoreAgentRuntime, 
    IMemoryManager as CoreMemoryManager, 
    Memory, 
    UUID,
    IRAGKnowledgeManager,
    ModelProviderName,
    Character,
    Provider
} from "@elizaos/core";

/**
 * Extended Memory Manager interface with additional methods for DAO operations
 */
export interface IExtendedMemoryManager extends CoreMemoryManager {
    // Memory retrieval operations
    getMemoriesWithPagination(options: any): Promise<{ items: Memory[]; hasMore: boolean; nextCursor?: UUID; }>;
    getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    
    // Lock-based operations
    getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]>;
    getMemoryWithLock(id: UUID): Promise<Memory | null>;
    removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void>;
    
    // Memory update operations
    updateMemory(memory: Memory): Promise<void>;
    updateMemoryWithVersion(id: UUID, update: Partial<Memory>, expectedVersion: number): Promise<boolean>;
    getLatestVersionWithLock(id: UUID): Promise<Memory | null>;
    
    // Subscription methods
    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void;
    subscribe(type: string, callback: (memory: any) => Promise<void>): void;
    unsubscribe(type: string, callback: (memory: any) => Promise<void>): void;
    
    // Transaction methods
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
    readonly isInTransaction: boolean;
    getTransactionLevel(): number;
    
    // Backward compatibility aliases
    on(type: string, callback: (memory: any) => Promise<void>): void;
    off(type: string, callback: (memory: any) => Promise<void>): void;
}

/**
 * Extended AgentRuntime interface with custom memory managers
 */
export interface ExtendedAgentRuntime extends Omit<CoreAgentRuntime, 'messageManager' | 'documentsManager' | 'knowledgeManager'> {
    messageManager: IExtendedMemoryManager;
    documentsManager: IExtendedMemoryManager;
    knowledgeManager: IExtendedMemoryManager;
    readonly descriptionManager: IExtendedMemoryManager;
    readonly loreManager: IExtendedMemoryManager;
    ragKnowledgeManager: IRAGKnowledgeManager;
    cacheManager: any;
    imageModelProvider: ModelProviderName;
    imageVisionModelProvider: ModelProviderName;
    character: Character;
    providers: Provider[];
    memoryManagers: Map<string, CoreMemoryManager>;
}

// Extend Memory type to include skipEmbedding flag
export interface ExtendedMemory extends Memory {
    skipEmbedding?: boolean;
} 