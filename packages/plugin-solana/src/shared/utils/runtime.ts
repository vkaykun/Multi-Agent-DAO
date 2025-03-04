//packages/plugin-solana/src/shared/utils/runtime.ts

import {
    elizaLogger,
    Action,
    Evaluator,
    Plugin,
    AgentRuntime,
    Memory,
    State,
    HandlerCallback,
    Service,
    ServiceType,
    Validator,
    UUID,
    IAgentRuntime as CoreAgentRuntime,
    ModelProviderName,
    Character,
    Provider,
    IMemoryManager as CoreMemoryManager,
    IRAGKnowledgeManager
} from "@elizaos/core";
import { BaseContent, AgentAction } from "../types/base.ts";
import { IAgentRuntime } from "../types/base.ts";
import { ExtendedMemory } from "../types/extended-runtime.ts";
import { getStandardizedRoomId, CONVERSATION_ROOM_ID } from "./messageUtils.ts";

interface CharacterConfig {
    actions?: string[];
    evaluators?: string[];
    plugins?: string[];
    providers?: string[];
    settings?: Record<string, unknown>;
}

/**
 * Load actions from a plugin
 */
async function loadActionsFromPlugin(pluginName: string): Promise<Action[]> {
    try {
        const plugin = await import(pluginName) as Plugin;
        return plugin.actions || [];
    } catch (error) {
        elizaLogger.error(`Failed to load actions from plugin ${pluginName}:`, error);
        return [];
    }
}

/**
 * Load evaluators from a plugin
 */
async function loadEvaluatorsFromPlugin(pluginName: string): Promise<Evaluator[]> {
    try {
        const plugin = await import(pluginName) as Plugin;
        return plugin.evaluators || [];
    } catch (error) {
        elizaLogger.error(`Failed to load evaluators from plugin ${pluginName}:`, error);
        return [];
    }
}

/**
 * Load actions from character configuration
 */
function loadActionsFromCharacter(character: CharacterConfig): string[] {
    return character.actions || [];
}

/**
 * Load plugins from character configuration
 */
async function loadPlugins(pluginNames: string[]): Promise<Plugin[]> {
    const plugins = await Promise.all(
        pluginNames.map(async (name) => {
            try {
                return await import(name) as Plugin;
            } catch (error) {
                elizaLogger.error(`Failed to load plugin ${name}:`, error);
                return null;
            }
        })
    );
    return plugins.filter((p): p is Plugin => p !== null);
}

/**
 * Load all runtime components from character configuration and plugins
 */
export async function loadRuntimeComponents(character: CharacterConfig) {
    // Load plugins first
    const plugins = await loadPlugins(character.plugins || []);

    // Load evaluators from plugins
    const pluginEvaluators = await Promise.all(
        plugins.map(plugin => plugin.evaluators || [])
    );

    // Load providers from plugins
    const providers = plugins.flatMap(plugin => plugin.providers || []);

    return {
        actions: [], // No longer loading action handlers
        evaluators: pluginEvaluators.flat(),
        providers
    };
}

/**
 * Interface for extended memory manager with additional methods for DAO operations
 */
export interface IExtendedMemoryManager extends CoreMemoryManager {
    // Additional memory operations for DAO
    getMemoriesWithPagination(options: any): Promise<{ items: Memory[]; hasMore: boolean; nextCursor?: UUID; }>;
    getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]>;
    getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]>;
    getMemoryWithLock(id: UUID): Promise<Memory | null>;
    removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void>;
    
    // Method for advanced filtering of memories
    getMemoriesWithFilters(options: { 
        domain: UUID; 
        count?: number; 
        filter?: Record<string, any>;
        sort?: { field: string; direction: 'asc' | 'desc' }[];
    }): Promise<Memory[]>;

    // Backward compatibility aliases
    on(type: string, callback: (memory: any) => Promise<void>): void;
    off(type: string, callback: (memory: any) => Promise<void>): void;
}

/**
 * Extended runtime interface with custom memory managers
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

/**
 * Extended MemoryManager that adds dimension mismatch handling
 * This implements the core memory manager to add dimension error handling
 */
export class ExtendedMemoryManager implements IExtendedMemoryManager {
    private baseManager: CoreMemoryManager;
    private memorySubscriptions: Map<string, Set<(memory: any) => Promise<void>>>;
    private _transactionLevel: number = 0;

    constructor(baseManager: CoreMemoryManager, memorySubscriptions: Map<string, Set<(memory: any) => Promise<void>>>) {
        this.baseManager = baseManager;
        this.memorySubscriptions = memorySubscriptions;
    }

    // Add missing transaction-related properties
    get isInTransaction(): boolean {
        return this._transactionLevel > 0;
    }
    
    getTransactionLevel(): number {
        return this._transactionLevel;
    }

    // Subscription methods
    subscribe(type: string, callback: (memory: any) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        const callbacks = this.memorySubscriptions.get(type)!;
        callbacks.add(callback);
    }

    unsubscribe(type: string, callback: (memory: any) => Promise<void>): void {
        if (this.memorySubscriptions.has(type)) {
            const callbacks = this.memorySubscriptions.get(type)!;
            callbacks.delete(callback);
        }
    }

    // Interface-required subscription methods
    subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.subscribe(type, callback as (memory: any) => Promise<void>);
    }

    unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.unsubscribe(type, callback as (memory: any) => Promise<void>);
    }

    // Backward compatibility aliases
    on(type: string, callback: (memory: any) => Promise<void>): void {
        this.subscribe(type, callback);
    }

    off(type: string, callback: (memory: any) => Promise<void>): void {
        this.unsubscribe(type, callback);
    }

    // Override createMemory to handle dimension mismatch errors
    async createMemory(memory: Memory, unique?: boolean): Promise<void> {
        try {
            // Standardize room ID for consistent retrieval
            if (memory.roomId) {
                const standardizedRoomId = getStandardizedRoomId(memory.roomId);
                memory.roomId = standardizedRoomId as UUID;
            }
            
            // Delegate to base implementation
            return await this.baseManager.createMemory(memory, unique);
        } catch (error) {
            // Check if this is a dimension mismatch error
            const errorMessage = String(error);
            if (errorMessage.includes('Invalid embedding dimension') || 
                errorMessage.includes('expected 1536') ||
                errorMessage.includes('dimension mismatch')) {
                
                elizaLogger.warn(`Caught dimension mismatch error in createMemory for ${memory.id}, trying without embedding`);
                
                try {
                    // Set flag to skip embedding generation
                    (memory as ExtendedMemory).skipEmbedding = true;
                    
                    // Use direct database adapter if available
                    if (this.runtime.databaseAdapter) {
                        // Access database adapter's createMemory directly
                        const dbAdapter = this.runtime.databaseAdapter as any;
                        if (typeof dbAdapter.createMemory === 'function') {
                            await dbAdapter.createMemory(
                                this.tableName,
                                {
                                    ...memory,
                                    embedding: null  // Explicitly set embedding to null
                                } as Memory,
                                unique
                            );
                            
                            elizaLogger.info(`Successfully stored memory ${memory.id} without embedding`);
                            return;
                        }
                    }
                } catch (fallbackError) {
                    elizaLogger.error(`Error in dimension error fallback for memory ${memory.id}:`, fallbackError);
                    // Re-throw the new error
                    throw fallbackError;
                }
            }
            
            // Re-throw unhandled errors
            throw error;
        }
    }

    // Required properties from IMemoryManager
    get runtime() { return this.baseManager.runtime; }
    get tableName() { return (this.baseManager as any).tableName; }

    // Lifecycle methods
    async initialize(): Promise<void> {
        return this.baseManager.initialize?.();
    }

    async shutdown(): Promise<void> {
        return this.baseManager.shutdown?.();
    }

    // Forward all required methods to base manager
    async getMemories(options: any): Promise<Memory[]> {
        return this.baseManager.getMemories(options);
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.baseManager.getMemoryById(id);
    }

    async getMemory(id: UUID): Promise<Memory | null> {
        return this.baseManager.getMemory(id);
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number; }): Promise<Memory[]> {
        return this.baseManager.getMemoriesByRoomIds(params);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.baseManager.countMemories(roomId, unique);
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        return this.baseManager.removeMemory(memoryId);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        return this.baseManager.removeAllMemories(roomId);
    }

    async resyncDomainMemory(): Promise<void> {
        return this.baseManager.resyncDomainMemory?.();
    }

    // Memory update operations required by interface
    async updateMemory(memory: Memory): Promise<void> {
        // Use base manager's updateMemory if available
        if (typeof (this.baseManager as any).updateMemory === 'function') {
            await (this.baseManager as any).updateMemory(memory);
        } else {
            // Fallback implementation - recreate the memory
            await this.createMemory(memory, true);
        }
        
        // Notify subscribers if content type exists
        if (memory.content && typeof memory.content.type === 'string') {
            const subscribers = this.memorySubscriptions.get(memory.content.type);
            if (subscribers) {
                for (const callback of subscribers) {
                    try {
                        await callback(memory);
                    } catch (error) {
                        elizaLogger.error(`Error in callback for memory type ${memory.content.type}:`, error);
                    }
                }
            }
        }
    }

    async updateMemoryWithVersion(id: UUID, update: Partial<Memory>, expectedVersion: number): Promise<boolean> {
        // Get the current memory
        const current = await this.getMemoryWithLock(id);
        if (!current || !current.content || current.content.version !== expectedVersion) {
            return false;
        }

        // Create updated memory
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

        // Update the memory
        await this.updateMemory(updatedMemory);
        return true;
    }

    async getLatestVersionWithLock(id: UUID): Promise<Memory | null> {
        return this.getMemoryWithLock(id);
    }

    // Additional required methods
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // If skipEmbedding flag is set, return the memory as is without embedding
        if ((memory as ExtendedMemory).skipEmbedding) {
            elizaLogger.info(`Skipping embedding generation for memory ${memory.id} (skipEmbedding flag set)`);
            return memory;
        }
        
        try {
            // Call the original method
            return await this.baseManager.addEmbeddingToMemory(memory);
        } catch (error) {
            // Check if this is a dimension mismatch error
            const errorMessage = String(error);
            if (errorMessage.includes('Invalid embedding dimension') || 
                errorMessage.includes('expected 1536') ||
                errorMessage.includes('dimension mismatch')) {
                
                elizaLogger.warn(`Caught embedding dimension mismatch error for memory ${memory.id}, storing without embedding`);
                
                // Return the memory without an embedding
                return memory;
            }
            
            // Re-throw other errors
            throw error;
        }
    }

    // Implement searchMemoriesByText
    async searchMemoriesByText(options: { roomId: UUID; text: string; count: number; filter?: Record<string, any>; }): Promise<Memory[]> {
        if (typeof (this.baseManager as any).searchMemoriesByText === 'function') {
            return (this.baseManager as any).searchMemoriesByText(options);
        }
        
        // Fallback if searchMemoriesByText is not available
        elizaLogger.warn('searchMemoriesByText not available in base manager, using getMemories fallback');
        return this.baseManager.getMemories({
            roomId: options.roomId,
            count: options.count,
            ...options.filter && { filter: options.filter }
        });
    }

    // Implement searchMemoriesByEmbedding
    async searchMemoriesByEmbedding(embedding: number[], opts: { match_threshold?: number; count?: number; roomId: UUID; unique?: boolean; }): Promise<Memory[]> {
        if (typeof this.baseManager.searchMemoriesByEmbedding === 'function') {
            return this.baseManager.searchMemoriesByEmbedding(embedding, opts);
        }
        
        // Fallback if searchMemoriesByEmbedding is not available
        elizaLogger.warn('searchMemoriesByEmbedding not available in base manager, using getMemories fallback');
        return this.baseManager.getMemories({
            roomId: opts.roomId,
            count: opts.count || 10,
            unique: opts.unique
        });
    }

    // Implement other required methods
    async getMemoriesWithPagination(options: any): Promise<{ items: Memory[]; hasMore: boolean; nextCursor?: UUID; }> {
        if (typeof (this.baseManager as any).getMemoriesWithPagination === 'function') {
            return (this.baseManager as any).getMemoriesWithPagination(options);
        }
        
        // Fallback implementation
        const memories = await this.baseManager.getMemories({
            roomId: options.roomId,
            count: options.count || 10,
            ...options.filter && { filter: options.filter }
        });
        
        return {
            items: memories,
            hasMore: false
        };
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        if (typeof (this.baseManager as any).getCachedEmbeddings === 'function') {
            return (this.baseManager as any).getCachedEmbeddings(content);
        }
        
        // Fallback for when function is not available
        return [];
    }

    async getMemoriesWithLock(options: { roomId: UUID; count: number; filter?: Record<string, any>; }): Promise<Memory[]> {
        // Fall back to regular getMemories if getMemoriesWithLock is not available
        if (typeof (this.baseManager as any).getMemoriesWithLock === 'function') {
            return (this.baseManager as any).getMemoriesWithLock(options);
        }
        
        return this.baseManager.getMemories({
            roomId: options.roomId,
            count: options.count,
            ...options.filter && { filter: options.filter }
        });
    }

    async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        // Fall back to regular getMemory if getMemoryWithLock is not available
        if (typeof (this.baseManager as any).getMemoryWithLock === 'function') {
            return (this.baseManager as any).getMemoryWithLock(id);
        }
        
        return this.baseManager.getMemory(id);
    }

    async removeMemoriesWhere(filter: { type: string; filter: Record<string, any>; }): Promise<void> {
        if (typeof (this.baseManager as any).removeMemoriesWhere === 'function') {
            return (this.baseManager as any).removeMemoriesWhere(filter);
        }
        throw new Error("removeMemoriesWhere is not implemented in the base memory manager");
    }

    /**
     * Get memories with advanced filtering options
     * @param options - Options for filtering memories
     * @returns Array of memories matching the filters
     */
    async getMemoriesWithFilters(options: { 
        domain: UUID; 
        count?: number; 
        filter?: Record<string, any>;
        sort?: { field: string; direction: 'asc' | 'desc' }[];
    }): Promise<Memory[]> {
        const { domain, count = 10, filter = {}, sort = [] } = options;
        
        // Attempt to use the base manager's method if available
        if (typeof (this.baseManager as any).getMemoriesWithFilters === 'function') {
            return (this.baseManager as any).getMemoriesWithFilters(options);
        }
        
        // Fallback to regular getMemories with filtering
        // Log that we're using fallback method
        const logPrefix = `[ExtendedMemoryManager:getMemoriesWithFilters]`;
        console.log(`${logPrefix} Using fallback implementation for domain: ${domain}, filter:`, filter);
        
        // Get all memories for the domain
        const memories = await this.baseManager.getMemories({
            roomId: domain,
            count: count * 3, // Get more to ensure we have enough after filtering
        });
        
        // Apply filters
        let filteredMemories = memories;
        if (filter && Object.keys(filter).length > 0) {
            filteredMemories = memories.filter(memory => {
                return Object.entries(filter).every(([key, value]) => {
                    // Handle object values in content
                    if (key.startsWith('content.') && memory.content) {
                        const contentKey = key.split('.')[1];
                        return memory.content[contentKey] === value;
                    }
                    return memory[key] === value;
                });
            });
        }
        
        // Apply sorting
        if (sort.length > 0) {
            filteredMemories.sort((a, b) => {
                for (const { field, direction } of sort) {
                    // Handle object values in content
                    if (field.startsWith('content.') && a.content && b.content) {
                        const contentKey = field.split('.')[1];
                        const aValue = a.content[contentKey];
                        const bValue = b.content[contentKey];
                        
                        if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                        if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                    } else {
                        if (a[field] < b[field]) return direction === 'asc' ? -1 : 1;
                        if (a[field] > b[field]) return direction === 'asc' ? 1 : -1;
                    }
                }
                return 0;
            });
        }
        
        // Apply limit
        const result = filteredMemories.slice(0, count);
        console.log(`${logPrefix} Filtered from ${memories.length} to ${filteredMemories.length} memories, returning ${result.length}`);
        
        return result;
    }

    // Transaction methods required by interface
    async beginTransaction(): Promise<void> {
        this._transactionLevel++;
        if (this._transactionLevel === 1 && typeof (this.baseManager as any).beginTransaction === 'function') {
            await (this.baseManager as any).beginTransaction();
        }
    }

    async commitTransaction(): Promise<void> {
        if (this._transactionLevel === 1 && typeof (this.baseManager as any).commitTransaction === 'function') {
            await (this.baseManager as any).commitTransaction();
        }
        this._transactionLevel = Math.max(0, this._transactionLevel - 1);
    }

    async rollbackTransaction(): Promise<void> {
        if (this._transactionLevel === 1 && typeof (this.baseManager as any).rollbackTransaction === 'function') {
            await (this.baseManager as any).rollbackTransaction();
        }
        this._transactionLevel = Math.max(0, this._transactionLevel - 1);
    }
}

export class SolanaAgentRuntime implements ExtendedAgentRuntime {
    private baseRuntime: AgentRuntime;
    private _agentType: "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER";
    private memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();
    private extendedMessageManager: ExtendedMemoryManager;
    private extendedDocumentsManager: ExtendedMemoryManager;
    private extendedKnowledgeManager: ExtendedMemoryManager;

    constructor(baseRuntime: AgentRuntime) {
        this.baseRuntime = baseRuntime;
        
        // Ensure agentType is set from the base runtime or default to TREASURY
        this._agentType = baseRuntime.agentType || "TREASURY";
        
        if (!this._agentType) {
            elizaLogger.warn("Agent type not set in base runtime, defaulting to TREASURY");
            this._agentType = "TREASURY";
        }
        
        // Check if memory managers are already instances of ExtendedMemoryManager
        // to avoid double-wrapping them
        this.extendedMessageManager = baseRuntime.messageManager instanceof ExtendedMemoryManager
            ? baseRuntime.messageManager
            : new ExtendedMemoryManager(baseRuntime.messageManager, this.memorySubscriptions);
        
        this.extendedDocumentsManager = baseRuntime.documentsManager instanceof ExtendedMemoryManager
            ? baseRuntime.documentsManager
            : new ExtendedMemoryManager(baseRuntime.documentsManager, this.memorySubscriptions);
        
        this.extendedKnowledgeManager = baseRuntime.knowledgeManager instanceof ExtendedMemoryManager
            ? baseRuntime.knowledgeManager
            : new ExtendedMemoryManager(baseRuntime.knowledgeManager, this.memorySubscriptions);
    }

    // Required properties from ExtendedAgentRuntime
    get agentId() { return this.baseRuntime.agentId; }
    get agentType() { return this._agentType; }
    set agentType(type: "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER") { this._agentType = type; }
    get messageManager() { return this.extendedMessageManager; }
    get documentsManager() { return this.extendedDocumentsManager; }
    get knowledgeManager() { return this.extendedKnowledgeManager; }
    get descriptionManager() { return this.extendedMessageManager; }
    get loreManager() { return this.extendedMessageManager; }
    get ragKnowledgeManager() { return this.baseRuntime.ragKnowledgeManager; }
    get cacheManager() { return this.baseRuntime.cacheManager; }
    get imageModelProvider() { return this.baseRuntime.imageModelProvider; }
    get imageVisionModelProvider() { return this.baseRuntime.imageVisionModelProvider; }
    get character() { return this.baseRuntime.character; }
    get providers() { return this.baseRuntime.providers; }
    get memoryManagers() { return this.baseRuntime.memoryManagers; }
    get serverUrl() { return this.baseRuntime.serverUrl; }
    get token() { return this.baseRuntime.token; }
    get modelProvider() { return this.baseRuntime.modelProvider; }
    get services() { return this.baseRuntime.services; }
    get clients() { return this.baseRuntime.clients; }
    set clients(value: any) { (this.baseRuntime as any).clients = value; }
    get actions() { return this.baseRuntime.actions; }
    get evaluators() { return this.baseRuntime.evaluators; }
    get plugins() { return this.baseRuntime.plugins; }
    get fetch() { return this.baseRuntime.fetch; }
    get verifiableInferenceAdapter() { return this.baseRuntime.verifiableInferenceAdapter; }
    get databaseAdapter() { return this.baseRuntime.databaseAdapter; }

    // Required methods
    async initialize() { return this.baseRuntime.initialize(); }
    registerMemoryManager(manager: any) { return this.baseRuntime.registerMemoryManager(manager); }
    getMemoryManager(name: string) { return this.baseRuntime.getMemoryManager(name); }
    getService<T extends Service>(service: ServiceType) { return this.baseRuntime.getService<T>(service); }
    registerService(service: any) { return this.baseRuntime.registerService(service); }
    getSetting(key: string) { return this.baseRuntime.getSetting(key); }
    getConversationLength() { return this.baseRuntime.getConversationLength(); }
    processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback) { return this.baseRuntime.processActions(message, responses, state, callback); }
    evaluate(message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback) { return this.baseRuntime.evaluate(message, state, didRespond, callback); }
    ensureParticipantExists(userId: UUID, roomId: UUID) { return this.baseRuntime.ensureParticipantExists(userId, roomId); }
    ensureUserExists(userId: UUID, userName: string | null, name: string | null, source: string | null) { return this.baseRuntime.ensureUserExists(userId, userName, name, source); }
    registerAction(action: any) { return this.baseRuntime.registerAction(action); }
    ensureConnection(userId: UUID, roomId: UUID, userName?: string, userScreenName?: string, source?: string) { return this.baseRuntime.ensureConnection(userId, roomId, userName, userScreenName, source); }
    ensureParticipantInRoom(userId: UUID, roomId: UUID) { return this.baseRuntime.ensureParticipantInRoom(userId, roomId); }
    ensureRoomExists(roomId: UUID) { return this.baseRuntime.ensureRoomExists(roomId); }
    composeState(message: Memory, additionalKeys?: any) { return this.baseRuntime.composeState(message, additionalKeys); }
    updateRecentMessageState(state: State) { return this.baseRuntime.updateRecentMessageState(state); }
}

// Helper function to create a Solana runtime
export async function createSolanaRuntime(config: any): Promise<ExtendedAgentRuntime> {
    try {
        // Ensure agentType is set in config
        if (!config.agentType) {
            elizaLogger.warn("Agent type not provided in config, defaulting to TREASURY");
            config.agentType = "TREASURY";
        }

        // Import patchMemoryManager here to ensure it's available
        const { patchMemoryManager } = await import("../fixes/memory-patch.ts");

        // Check if config already contains extended memory managers
        if (config.messageManager && config.messageManager instanceof ExtendedMemoryManager) {
            elizaLogger.info("Config already contains ExtendedMemoryManager, using it directly");
            
            // Create base runtime with the provided memory managers
            elizaLogger.info("Creating base runtime with agent type:", config.agentType);
            const baseRuntime = new AgentRuntime(config);

            // Initialize base runtime 
            elizaLogger.info("Initializing base runtime...");
            await baseRuntime.initialize();
            elizaLogger.info("Base runtime initialized");

            // Create Solana runtime
            elizaLogger.info("Creating Solana runtime (preserving existing memory managers)...");
            const solanaRuntime = new SolanaAgentRuntime(baseRuntime);
            
            // Explicitly set the agent type
            solanaRuntime.agentType = config.agentType;

            elizaLogger.info("Initializing Solana runtime...");
            await solanaRuntime.initialize();
            elizaLogger.info("Solana runtime initialized with agent type:", solanaRuntime.agentType);
            
            // Explicitly patch the memory manager after Solana runtime is fully initialized
            elizaLogger.info("📌 Explicitly patching memory manager after Solana runtime initialization");
            // Use type assertion to match the expected interface
            patchMemoryManager(solanaRuntime as any);
            
            return solanaRuntime;
        } else {
            // Legacy path - create memory managers
            elizaLogger.info("No ExtendedMemoryManager in config, creating new instances");
            
            // Create memory subscriptions map
            const memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();

            // Create base runtime
            elizaLogger.info("Creating base runtime with agent type:", config.agentType);
            const baseRuntime = new AgentRuntime({
                ...config,
                agentType: config.agentType
            });

            // Initialize base runtime first
            elizaLogger.info("Initializing base runtime...");
            await baseRuntime.initialize();
            elizaLogger.info("Base runtime initialized");

            // Create extended memory manager
            elizaLogger.info("Creating new ExtendedMemoryManager instance");
            const extendedMemoryManager = new ExtendedMemoryManager(
                baseRuntime.messageManager,
                memorySubscriptions
            );
            
            // Initialize memory manager
            elizaLogger.info("Initializing extended memory manager...");
            await extendedMemoryManager.initialize();
            elizaLogger.info("Extended memory manager initialized");

            // Create Solana runtime
            elizaLogger.info("Creating Solana runtime...");
            const solanaRuntime = new SolanaAgentRuntime(baseRuntime);
            
            // Explicitly set the agent type
            solanaRuntime.agentType = config.agentType;

            // Register unified memory manager
            elizaLogger.info("Registering extended memory managers...");
            solanaRuntime.registerMemoryManager(extendedMemoryManager);

            // Initialize the Solana runtime
            elizaLogger.info("Initializing Solana runtime...");
            await solanaRuntime.initialize();
            elizaLogger.info("Solana runtime initialized with agent type:", solanaRuntime.agentType);
            
            // Explicitly patch the memory manager after Solana runtime is fully initialized
            elizaLogger.info("📌 Explicitly patching memory manager after Solana runtime initialization");
            // Use type assertion to match the expected interface
            patchMemoryManager(solanaRuntime as any);
            
            return solanaRuntime;
        }
    } catch (error) {
        elizaLogger.error("Error creating Solana runtime:", error);
        throw error;
    }
}

/**
 * Creates an extended runtime with dimension mismatch handling
 * @param baseRuntime The base runtime to extend
 * @returns Extended runtime with enhanced error handling
 */
export function createExtendedRuntime(baseRuntime: any): ExtendedAgentRuntime {
    // Start with the base runtime
    const extendedRuntime = baseRuntime as ExtendedAgentRuntime;
    
    // Replace the memory manager with our extended version
    const originalMemoryManager = extendedRuntime.messageManager;
    
    // Only replace if it exists and isn't already extended
    if (originalMemoryManager && !(originalMemoryManager instanceof ExtendedMemoryManager)) {
        elizaLogger.info("Replacing original memory manager with extended version that handles dimension mismatches");
        
        // Create memorySubscriptions Map
        const memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();
        
        // Create the extended memory manager with the base manager
        const extendedMemoryManager = new ExtendedMemoryManager(originalMemoryManager, memorySubscriptions);
        
        // Replace the memory manager
        extendedRuntime.messageManager = extendedMemoryManager;
    }
    
    return extendedRuntime;
}

// Function to check if the EMBEDDING_OPENAI_MODEL matches what we expect
export function validateEmbeddingModel(): void {
    const embeddingModel = process.env.EMBEDDING_OPENAI_MODEL;
    const expectedModel = 'text-embedding-ada-002';
    
    if (!embeddingModel) {
        elizaLogger.warn("⚠️ EMBEDDING_OPENAI_MODEL is not set in environment variables");
        return;
    }
    
    if (embeddingModel !== expectedModel) {
        elizaLogger.warn(`⚠️ EMBEDDING_OPENAI_MODEL is set to ${embeddingModel}, but ${expectedModel} is recommended for dimensions compatibility`);
    } else {
        elizaLogger.info(`✅ EMBEDDING_OPENAI_MODEL correctly set to ${expectedModel}`);
    }
} 