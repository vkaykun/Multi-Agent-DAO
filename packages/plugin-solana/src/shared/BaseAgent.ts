import {
    Memory,
    State,
    elizaLogger,
    stringToUuid,
    UUID,
    Content,
    AgentRuntime
} from "@elizaos/core";
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
    IAgentRuntime,
    REQUIRED_MEMORY_TYPES
} from "./types/base";
import { MemoryQueryOptions } from "./types/memory";
import { 
    AGENT_IDS, 
    GLOBAL_MEMORY_TYPES, 
    ROOM_IDS, 
    getMemoryRoom,
    AGENT_SPECIFIC_MEMORY_TYPES,
    AgentSpecificMemoryType 
} from "./constants";
import { CacheService } from "./services/CacheService";
import { getPaginatedMemories, getAllMemories, processMemoriesInChunks } from './utils/memory';
import { getMemoryManager } from "./memory/MemoryManagerFactory";
import { MEMORY_SUBSCRIPTIONS, MemorySubscriptionConfig } from "./types/memory-subscriptions";
import { MessageBroker } from './MessageBroker';
import { MemoryEvent, MemorySubscription } from './types/memory-events';
import { actionRegistry, ActionDefinition } from "./actions/registry";
import * as path from "path";
import * as fs from "fs";
import { exponentialBackoff } from './utils/backoff';
import { getMemoryDomain, shouldArchiveMemory, isDescriptiveMemory } from './utils/memory-utils';

// Local interface definitions
interface DistributedLock {
    key: string;
    holder: UUID;
    expiresAt: number;
    lockId: number;
}

interface TransactionOptions {
    maxRetries?: number;
    timeoutMs?: number;
    isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE';
    backoff?: {
        initialDelayMs: number;
        maxDelayMs: number;
        factor: number;
    };
    lockKeys?: string[];  // Add lock keys to transaction options
}

export abstract class BaseAgent {
    protected id: UUID;
    protected runtime: IAgentRuntime;
    protected messageBroker: MessageBroker;
    protected state: AgentState;
    protected capabilities: Map<string, AgentCapability>;
    protected messageQueue: AgentMessage[];
    protected watchedRooms: Set<UUID>;
    protected eventSubscriptions: Map<DAOEventType, ((event: DAOEvent) => Promise<void>)[]>;
    protected characterName?: string;
    protected sharedDatabase?: any;
    protected settings: Map<string, unknown>;
    protected cacheService: CacheService;
    private _isInTransaction: boolean = false;
    private readonly LOCK_TIMEOUT = 30000;
    private readonly LOCK_RETRY_DELAY = 1000;
    private readonly MAX_LOCK_RETRIES = 5;

    protected memoryMonitoringConfig = {
        batchSize: 50,      // Maximum number of memories to process per fetch
        errorThreshold: 3,  // Number of consecutive errors before backing off
        resetThreshold: 5,  // Number of successful fetches before resetting interval
        backoffFactor: 1.5, // Exponential backoff multiplier
        minInterval: 1000,  // Minimum interval between fetches
        maxInterval: 30000  // Maximum interval after backoff
    };

    private currentInterval: number;
    private consecutiveErrors: number = 0;
    private successfulFetches: number = 0;
    private lastProcessedTime: number = Date.now();
    private isProcessing: boolean = false;
    private monitoringTimeout: NodeJS.Timeout | null = null;
    private roomLastProcessedTimes: Map<UUID, number> = new Map();
    protected memorySubscriptions: Map<string, Set<(memory: Memory) => Promise<void>>> = new Map();

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.id = runtime.agentId;
        this.state = {
            id: runtime.agentId,
            type: runtime.agentType,
            status: "initializing",
            capabilities: [],
            lastActive: Date.now()
        };
        this.capabilities = new Map();
        this.messageQueue = [];
        this.watchedRooms = new Set([
            ROOM_IDS.DAO, // Always watch global room
            ROOM_IDS[runtime.agentType] // Watch agent's domain room
        ]);
        this.eventSubscriptions = new Map();
        this.settings = new Map();
        this.currentInterval = this.memoryMonitoringConfig.minInterval;

        // Initialize cache service
        this.cacheService = new CacheService(runtime);

        // Start memory monitoring
        this.startMemoryMonitoring();

        // Set up required memory subscriptions
        this.setupRequiredMemorySubscriptions();

        this.messageBroker = MessageBroker.getInstance();
    }

    public getId(): UUID {
        return this.id;
    }

    public getType(): AgentType {
        return this.runtime.agentType;
    }

    public getState(): AgentState {
        return { ...this.state };
    }

    protected async updateState(partial: Partial<AgentState>): Promise<void> {
        this.state = {
            ...this.state,
            ...partial,
            lastActive: Date.now()
        };
        await this.persistState();
    }

    protected async persistState(): Promise<void> {
        await this.runtime.messageManager.createMemory({
            id: stringToUuid(`${this.id}_state`),
            roomId: this.id,
            userId: this.id,
            agentId: this.id,
            content: {
                ...this.state,
                text: `Agent state update: ${this.state.status}`
            }
        });
    }

    public setCharacterName(name: string): void {
        this.characterName = name;
    }

    public async sendMessage(message: AgentMessage): Promise<void> {
        try {
            const memoryId = stringToUuid(`message-${Date.now()}`);
            const roomId = message.global ? ROOM_IDS.DAO : this.runtime.agentId;
            
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    type: "agent_message",
                    text: message.content.text || `Message from ${this.runtime.agentType}`,
                    ...message
                },
                roomId,
                userId: this.id,
                agentId: this.runtime.agentId
            });

            if (this.characterName) {
                message.characterName = this.characterName as CharacterName;
            }
        } catch (error) {
            elizaLogger.error(`Error sending agent message:`, error);
            throw error;
        }
    }

    protected async receiveMessage(message: AgentMessage): Promise<void> {
        if (message.to === this.runtime.agentType || message.to === "ALL") {
            this.messageQueue.push(message);
            await this.processMessageQueue();
        }
    }

    protected async processMessageQueue(): Promise<void> {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (message) {
                await this.handleMessage(message);
            }
        }
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            // Determine the appropriate room based on whether the message is global
            const roomId = message.global ? ROOM_IDS.DAO : this.runtime.agentId;

            // Create memory for the message
            const memory: Memory = {
                id: stringToUuid(`mem-${Date.now()}`),
                content: {
                    ...message,
                    text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
                    from: message.from,
                    to: message.to
                },
                roomId,
                userId: this.id,
                agentId: this.runtime.agentId
            };

            // First store the memory
            await this.runtime.messageManager.createMemory(memory);

            // Compose state for message processing
            const state = await this.runtime.composeState(memory, {
                agentId: this.runtime.agentId,
                roomId: roomId
            });

            // Process through evaluators and actions pipeline
            let wasHandled = false;
            try {
                const result = await this.runtime.processActions(
                    memory,
                    [memory], // Include original memory in context
                    state,
                    async (response: Content) => {
                        // Create response memory
                        const responseMemory: Memory = {
                            id: stringToUuid(`response-${Date.now()}`),
                            content: response,
                            roomId,
                            userId: this.runtime.agentId,
                            agentId: this.runtime.agentId
                        };
                        await this.runtime.messageManager.createMemory(responseMemory);
                        return [responseMemory];
                    }
                );
                wasHandled = result !== undefined;
            } catch (error) {
                elizaLogger.error(`Error processing actions:`, error);
                wasHandled = false;
            }

            // Run evaluations regardless of whether actions were triggered
            try {
                await this.runtime.evaluate(memory, state, wasHandled);
            } catch (error) {
                elizaLogger.error(`Error in evaluation:`, error);
                // Continue execution even if evaluation fails
            }

        } catch (error) {
            elizaLogger.error(`Error in BaseAgent.handleMessage:`, error);
            throw error;
        }
    }

    protected abstract validateAction(content: BaseContent): Promise<boolean>;

    public abstract executeAction(content: BaseContent): Promise<boolean>;

    protected async logAction(
        action: string,
        content: BaseContent,
        success: boolean,
        error?: string
    ): Promise<void> {
        try {
            const memoryId = stringToUuid(`action-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    type: "agent_action",
                    text: `${this.runtime.agentType} executed ${action}`,
                    action,
                    content,
                    success,
                    error,
                    timestamp: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: this.id,
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error(`Error logging agent action:`, error);
        }
    }

    public hasCapability(name: string): boolean {
        return this.capabilities.has(name);
    }

    public registerCapability(capability: AgentCapability): void {
        this.capabilities.set(capability.name, capability);
        this.state.capabilities = Array.from(this.capabilities.values());
        elizaLogger.debug(`Registered capability for ${this.runtime.agentType} agent: ${capability.name}`);
    }

    public getCapabilities(): AgentCapability[] {
        return Array.from(this.capabilities.values());
    }

    public async initialize(): Promise<void> {
        elizaLogger.info(`Initializing agent ${this.id}`);
        
        // Load and register actions
        this.loadActions();
        
        // Setup memory subscriptions
        await this.setupMemorySubscriptions();
        
        // Initialize message broker
        this.messageBroker = MessageBroker.getInstance();
        
        // Setup cross-process event handling
        await this.setupCrossProcessEvents();

        // Load previous state if exists
        const previousStates = await this.runtime.messageManager.getMemories({
            roomId: this.id,
            count: 1
        });

        const lastState = previousStates.find(memory => 
            memory.content.type === "agent_state" &&
            memory.userId === this.id
        );

        if (lastState) {
            const previousState = lastState.content as unknown as AgentState;
            this.state = {
                ...previousState,
                status: "active",
                lastActive: Date.now()
            };
        }

        await this.persistState();
    }

    public async shutdown(): Promise<void> {
        if (this.monitoringTimeout) {
            clearTimeout(this.monitoringTimeout);
            this.monitoringTimeout = null;
        }
        
        this.isProcessing = false;
        this.state.status = "inactive";
        await this.persistState();

        // Clean up all subscriptions
        this.eventSubscriptions.clear();
    }

    protected async beginTransaction(): Promise<void> {
        if (this._isInTransaction) {
            throw new Error('Nested transactions are not allowed');
        }
        await this.runtime.messageManager.beginTransaction();
        this._isInTransaction = true;
    }

    protected async commitTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No active transaction to commit');
        }
        await this.runtime.messageManager.commitTransaction();
        this._isInTransaction = false;
    }

    protected async rollbackTransaction(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No active transaction to rollback');
        }
        await this.runtime.messageManager.rollbackTransaction();
        this._isInTransaction = false;
    }

    protected async executeAtomicOperation<T>(operation: () => Promise<T>): Promise<T> {
        if (this._isInTransaction) {
            return operation();
        }

        try {
            await this.beginTransaction();
            this._isInTransaction = true;
            const result = await operation();
            await this.commitTransaction();
            return result;
        } catch (error) {
            if (this._isInTransaction) {
                await this.rollbackTransaction();
            }
            throw error;
        } finally {
            this._isInTransaction = false;
        }
    }

    protected async createMemory(content: BaseContent): Promise<void> {
        const domain = getMemoryDomain(content.type);
        const isArchived = shouldArchiveMemory(content.type, content.status);
        const isDescriptive = isDescriptiveMemory(content.type);

        // Choose appropriate memory manager
        const manager = isDescriptive ? this.runtime.descriptionManager :
                       isArchived ? this.runtime.loreManager :
                       this.runtime.messageManager;

        const memory: Memory = {
            id: content.id || stringToUuid(`mem-${Date.now()}`),
            content: {
                ...content,
                agentId: this.runtime.agentId,
                createdAt: content.createdAt || Date.now(),
                updatedAt: content.updatedAt || Date.now()
            },
            roomId: getMemoryRoom(content.type, this.runtime.agentId),
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId
        };

        await manager.createMemory(memory);
    }

    protected async queryMemories<T extends BaseContent>(options: {
        type: string;
        filter?: (item: T) => boolean;
        sort?: (a: T, b: T) => number;
        limit?: number;
    }): Promise<T[]> {
        const domain = getMemoryDomain(options.type);
        const isArchived = shouldArchiveMemory(options.type);
        const isDescriptive = isDescriptiveMemory(options.type);

        const manager = isDescriptive ? this.runtime.descriptionManager :
                       isArchived ? this.runtime.loreManager :
                       this.runtime.messageManager;

        const memories = await manager.getMemories({
            roomId: getMemoryRoom(options.type, this.runtime.agentId),
            count: options.limit || 100
        });

        let items = memories
            .filter(m => m.content.type === options.type)
            .map(m => m.content as T);

        if (options.filter) {
            items = items.filter(options.filter);
        }

        if (options.sort) {
            items = items.sort(options.sort);
        }

        return items;
    }

    protected setupRequiredMemorySubscriptions(): void {
        const requiredTypes = REQUIRED_MEMORY_TYPES[this.runtime.agentType] || [];
        for (const type of requiredTypes) {
            this.runtime.messageManager.on(type, async (memory: Memory) => {
                await this.handleMemory(memory);
            });
        }
    }

    protected subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        if (!this.memorySubscriptions.has(type)) {
            this.memorySubscriptions.set(type, new Set());
        }
        this.memorySubscriptions.get(type)?.add(callback);
        this.runtime.messageManager.on(type, callback);
    }

    protected unsubscribeFromMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        this.memorySubscriptions.get(type)?.delete(callback);
        if (this.memorySubscriptions.get(type)?.size === 0) {
            this.memorySubscriptions.delete(type);
        }
        this.runtime.messageManager.off(type, callback);
    }

    protected async setupMemorySubscriptions(): Promise<void> {
        const requiredTypes = REQUIRED_MEMORY_TYPES[this.runtime.agentType] || [];
        for (const type of requiredTypes) {
            this.runtime.messageManager.on(type, async (memory: Memory) => {
                await this.handleMemory(memory);
            });
        }
    }

    // Update memory monitoring to use pagination
    private async monitorMemories(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            for (const roomId of this.watchedRooms) {
                const lastTime = this.roomLastProcessedTimes.get(roomId) || 0;
                const result = await getPaginatedMemories(this.runtime.messageManager, roomId, {
                    type: "memory",
                    pagination: {
                        pageSize: this.memoryMonitoringConfig.batchSize,
                        maxPages: 1
                    },
                    filter: (content: BaseContent) => {
                        return content.createdAt > lastTime;
                    }
                });

                if (result.items.length > 0) {
                    // Process memories in order
                    for (const item of result.items) {
                        // Skip own memories
                        if (item.agentId === this.id) continue;

                        // Create proper Memory object
                        const memory: Memory = {
                            id: stringToUuid(`mem-${Date.now()}`),
                            content: item,
                            roomId,
                            userId: item.agentId,
                            agentId: this.runtime.agentId
                        };

                        // Process memory
                        await this.handleMemory(memory);

                        // Update last processed time for this room
                        if (item.createdAt > lastTime) {
                            this.roomLastProcessedTimes.set(roomId, item.createdAt);
                        }
                    }

                    // Successful fetch with data
                    this.successfulFetches++;
                    this.consecutiveErrors = 0;

                    // Reset interval if we've had enough successful fetches
                    if (this.successfulFetches >= this.memoryMonitoringConfig.resetThreshold) {
                        this.currentInterval = this.memoryMonitoringConfig.minInterval;
                        this.successfulFetches = 0;
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error monitoring memories:", error);
            this.consecutiveErrors++;
            
            // Apply backoff if we've hit the error threshold
            if (this.consecutiveErrors >= this.memoryMonitoringConfig.errorThreshold) {
                this.currentInterval = Math.min(
                    this.currentInterval * this.memoryMonitoringConfig.backoffFactor,
                    this.memoryMonitoringConfig.maxInterval
                );
            }
        } finally {
            this.isProcessing = false;
            
            // Schedule next check
            if (this.monitoringTimeout) {
                clearTimeout(this.monitoringTimeout);
            }
            this.monitoringTimeout = setTimeout(() => this.monitorMemories(), this.currentInterval);
        }
    }

    private startMemoryMonitoring(): void {
        this.currentInterval = this.memoryMonitoringConfig.minInterval;
        this.monitorMemories();
    }

    public async setDatabase(database: any): Promise<void> {
        this.sharedDatabase = database;
        elizaLogger.info(`Set shared database for agent ${this.runtime.agentType}`);
    }

    protected async broadcastEvent(event: DAOEvent): Promise<void> {
        try {
            // Store in memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`event-${event.eventId}`),
                content: event,
                roomId: this.runtime.agentId,
                userId: this.id,
                agentId: this.runtime.agentId
            });

            // Notify subscribers
            const subscribers = this.eventSubscriptions.get(event.type) || [];
            await Promise.all(subscribers.map(callback => callback(event)));

            elizaLogger.info(`Broadcasted event ${event.type} from ${this.runtime.agentType}`);
        } catch (error) {
            elizaLogger.error(`Error broadcasting event:`, error);
            throw error;
        }
    }

    public subscribeToEvent(
        eventType: DAOEventType,
        callback: (event: DAOEvent) => Promise<void>
    ): void {
        const subscribers = this.eventSubscriptions.get(eventType) || [];
        subscribers.push(callback);
        this.eventSubscriptions.set(eventType, subscribers);
        elizaLogger.info(`${this.runtime.agentType} subscribed to event type: ${eventType}`);
    }

    public unsubscribeFromEvent(
        eventType: DAOEventType,
        callback: (event: DAOEvent) => Promise<void>
    ): void {
        const subscribers = this.eventSubscriptions.get(eventType) || [];
        const index = subscribers.indexOf(callback);
        if (index > -1) {
            subscribers.splice(index, 1);
            this.eventSubscriptions.set(eventType, subscribers);
            elizaLogger.info(`${this.runtime.agentType} unsubscribed from event type: ${eventType}`);
        }
    }

    // Add settings management methods
    public setSetting(key: string, value: unknown): void {
        this.settings.set(key, value);
        elizaLogger.debug(`Set ${this.runtime.agentType} agent setting: ${key}=${value}`);
    }

    public getSetting(key: string): unknown | undefined {
        return this.settings.get(key);
    }

    public getSettings(): Map<string, unknown> {
        return new Map(this.settings);
    }

    protected abstract handleMemory(memory: Memory): Promise<void>;

    protected abstract loadActions(): void;
    protected abstract setupCrossProcessEvents(): Promise<void>;

    protected async acquireDistributedLock(
        key: string,
        timeoutMs: number = this.LOCK_TIMEOUT
    ): Promise<DistributedLock | null> {
        const lockId = this.generateLockId(key);
        const expiresAt = Date.now() + timeoutMs;

        try {
            // Create lock record in memory store
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`lock-${key}-${lockId}`),
                content: {
                    type: "distributed_lock",
                    key,
                    holder: this.id,
                    expiresAt,
                    lockId,
                    text: `Lock acquired for ${key}`,
                    agentId: this.id,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                roomId: this.id,
                userId: this.id,
                agentId: this.id,
                unique: true // Ensure only one lock exists
            });

            return { key, holder: this.id, expiresAt, lockId };
        } catch (error) {
            elizaLogger.warn(`Failed to acquire lock for ${key}:`, error);
            return null;
        }
    }

    protected async releaseDistributedLock(lock: DistributedLock): Promise<void> {
        try {
            // Find and remove the lock record
            const lockMemory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(`lock-${lock.key}-${lock.lockId}`)
            );

            if (lockMemory && lockMemory.content.holder === this.id) {
                await this.runtime.messageManager.removeMemory(lockMemory.id);
                elizaLogger.debug(`Released lock for ${lock.key}`);
            }
        } catch (error) {
            elizaLogger.error(`Error releasing lock for ${lock.key}:`, error);
        }
    }

    private generateLockId(key: string): number {
        return Math.abs(Array.from(key).reduce((hash, char) => {
            return ((hash << 5) - hash) + char.charCodeAt(0);
        }, 0));
    }
}