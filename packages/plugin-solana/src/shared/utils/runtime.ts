//runtime.ts/utils/runtime.ts (new file)

import { elizaLogger, Action, Evaluator, Plugin, AgentRuntime, IAgentRuntime as CoreAgentRuntime, Memory, State, HandlerCallback, Service, ServiceType, Validator, UUID } from "@elizaos/core";
import { actionRegistry } from "../actions/registry";
import { ActionDefinition } from "../actions/registry";
import { BaseContent } from "../types/base";
import { IAgentRuntime } from "../types/base";
import { ExtendedMemoryManager } from "../memory/ExtendedMemoryManager";

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
function loadActionsFromCharacter(character: CharacterConfig): ActionDefinition<BaseContent>[] {
    return (character.actions || [])
        .map(actionName => actionRegistry.getAction(actionName))
        .filter((action): action is ActionDefinition<BaseContent> => action !== undefined);
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

export class SolanaAgentRuntime implements IAgentRuntime {
    private memorySubscriptions = new Map<string, Set<(memory: any) => Promise<void>>>();
    private extendedMessageManager: ExtendedMemoryManager;

    constructor(private baseRuntime: AgentRuntime) {
        this.extendedMessageManager = new ExtendedMemoryManager(
            baseRuntime.messageManager,
            this.memorySubscriptions
        );
    }

    // Required properties from IAgentRuntime
    get agentId() { return this.baseRuntime.agentId; }
    get agentType() { return this.baseRuntime.agentType; }
    get messageManager() { return this.extendedMessageManager; }
    get descriptionManager() { return this.baseRuntime.descriptionManager; }
    get loreManager() { return this.baseRuntime.loreManager; }
    get databaseAdapter() { return this.baseRuntime.databaseAdapter; }
    get cacheManager() { return this.baseRuntime.cacheManager; }
    get serverUrl() { return this.baseRuntime.serverUrl; }
    get token() { return this.baseRuntime.token; }
    get modelProvider() { return this.baseRuntime.modelProvider; }
    get imageModelProvider() { return this.baseRuntime.imageModelProvider; }
    get imageVisionModelProvider() { return this.baseRuntime.imageVisionModelProvider; }
    get documentsManager() { return this.baseRuntime.documentsManager; }
    get knowledgeManager() { return this.baseRuntime.knowledgeManager; }
    get ragKnowledgeManager() { return this.baseRuntime.ragKnowledgeManager; }
    get services() { return this.baseRuntime.services; }
    get memoryManagers() { return this.baseRuntime.memoryManagers; }
    get clients() { return this.baseRuntime.clients; }
    get verifiableInferenceAdapter() { return this.baseRuntime.verifiableInferenceAdapter; }
    get character() { return this.baseRuntime.character; }
    get providers() { return this.baseRuntime.providers; }
    get actions() { return this.baseRuntime.actions; }
    get plugins() { return this.baseRuntime.plugins; }
    get evaluators() { return this.baseRuntime.evaluators; }

    // Required methods
    async initialize() { return this.baseRuntime.initialize(); }
    getSetting(key: string) { return this.baseRuntime.getSetting(key); }
    evaluate(message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback) { 
        return this.baseRuntime.evaluate(message, state, didRespond, callback); 
    }
    processActions(message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback) { 
        return this.baseRuntime.processActions(message, responses, state, callback); 
    }
    composeState(context: any) { return this.baseRuntime.composeState(context); }
    registerMemoryManager(manager: any) { return this.baseRuntime.registerMemoryManager(manager); }
    getMemoryManager(tableName: string) { return this.baseRuntime.getMemoryManager(tableName); }
    registerAction(action: any) { return this.baseRuntime.registerAction(action); }
    registerService(service: any) { return this.baseRuntime.registerService(service); }
    getService<T extends Service>(service: ServiceType): T { return this.baseRuntime.getService(service); }
    
    // Connection and room methods
    async ensureConnection(participantId: UUID, roomId: UUID) { 
        return this.baseRuntime.ensureConnection(participantId, roomId); 
    }
    async ensureParticipantInRoom(participantId: UUID, roomId: UUID) { 
        return this.baseRuntime.ensureParticipantInRoom(participantId, roomId); 
    }
    async ensureRoomExists(roomId: UUID) { 
        return this.baseRuntime.ensureRoomExists(roomId); 
    }
    async updateRecentMessageState(state: State) { 
        return this.baseRuntime.updateRecentMessageState(state); 
    }
    
    // Participant methods
    async ensureParticipantExists(participantId: UUID, roomId: UUID) { 
        return this.baseRuntime.ensureParticipantExists(participantId, roomId); 
    }
    async ensureUserExists(userId: UUID, roomId: UUID, role: string, metadata?: any, options?: any) { 
        return this.baseRuntime.ensureUserExists(userId, roomId, role, metadata, options); 
    }
    getConversationLength(): number { 
        return this.baseRuntime.getConversationLength(); 
    }
}

// Helper function to create a Solana runtime
export async function createSolanaRuntime(config: any): Promise<IAgentRuntime> {
    const baseRuntime = new AgentRuntime(config);
    await baseRuntime.initialize();
    return new SolanaAgentRuntime(baseRuntime);
} 