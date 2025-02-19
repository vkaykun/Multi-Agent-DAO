import { elizaLogger, Memory, UUID } from "@elizaos/core";
import { MessageBroker } from "../MessageBroker";
import { EventEmitter } from "events";

interface MemorySyncMessage {
    type: "memory_sync";
    operation: "create" | "update" | "delete";
    memory: Memory;
    timestamp: number;
    processId: number;
}

/**
 * Manages memory synchronization between processes
 * This ensures that ephemeral memory and conversation context
 * stay consistent across all processes
 */
export class MemorySyncManager extends EventEmitter {
    private static instance: MemorySyncManager;
    private messageBroker: MessageBroker;
    private lastSyncTimestamp: number = 0;
    private recentMemories: Map<UUID, Memory> = new Map();
    private readonly RECENT_MEMORY_TTL = 5 * 60 * 1000; // 5 minutes

    private constructor() {
        super();
        this.messageBroker = MessageBroker.getInstance();
        this.setupProcessHandlers();
        this.startCleanupInterval();
    }

    public static getInstance(): MemorySyncManager {
        if (!MemorySyncManager.instance) {
            MemorySyncManager.instance = new MemorySyncManager();
        }
        return MemorySyncManager.instance;
    }

    private setupProcessHandlers(): void {
        // Listen for messages from parent or child processes
        process.on("message", (message: MemorySyncMessage) => {
            if (message.type === "memory_sync") {
                this.handleSyncMessage(message);
            }
        });

        // Listen for memory events from MessageBroker
        this.messageBroker.on("memory_created", (memory: Memory) => {
            this.broadcastMemoryUpdate("create", memory);
        });

        this.messageBroker.on("memory_updated", (memory: Memory) => {
            this.broadcastMemoryUpdate("update", memory);
        });

        this.messageBroker.on("memory_deleted", (memoryId: UUID) => {
            const memory = this.recentMemories.get(memoryId);
            if (memory) {
                this.broadcastMemoryUpdate("delete", memory);
            }
        });
    }

    private handleSyncMessage(message: MemorySyncMessage): void {
        // Skip if message is from this process
        if (message.processId === process.pid) {
            return;
        }

        // Skip if message is older than our last sync
        if (message.timestamp <= this.lastSyncTimestamp) {
            return;
        }

        try {
            switch (message.operation) {
                case "create":
                case "update":
                    this.recentMemories.set(message.memory.id, message.memory);
                    this.emit("memory_synced", message.memory);
                    break;
                case "delete":
                    this.recentMemories.delete(message.memory.id);
                    this.emit("memory_deleted", message.memory.id);
                    break;
            }

            this.lastSyncTimestamp = message.timestamp;
        } catch (error) {
            elizaLogger.error("Error handling memory sync message:", error);
        }
    }

    private broadcastMemoryUpdate(operation: "create" | "update" | "delete", memory: Memory): void {
        const message: MemorySyncMessage = {
            type: "memory_sync",
            operation,
            memory,
            timestamp: Date.now(),
            processId: process.pid
        };

        // Store in recent memories
        if (operation !== "delete") {
            this.recentMemories.set(memory.id, memory);
        } else {
            this.recentMemories.delete(memory.id);
        }

        // Send to other processes
        if (process.send) {
            process.send(message);
        }

        // Update last sync timestamp
        this.lastSyncTimestamp = message.timestamp;
    }

    private startCleanupInterval(): void {
        setInterval(() => {
            const now = Date.now();
            for (const [id, memory] of this.recentMemories) {
                const createdAt = typeof memory.content.createdAt === 'number' ? memory.content.createdAt : 0;
                if (now - createdAt > this.RECENT_MEMORY_TTL) {
                    this.recentMemories.delete(id);
                }
            }
        }, 60000); // Run cleanup every minute
    }

    public getRecentMemory(id: UUID): Memory | undefined {
        return this.recentMemories.get(id);
    }

    public getAllRecentMemories(): Memory[] {
        return Array.from(this.recentMemories.values());
    }

    public onMemorySynced(callback: (memory: Memory) => void): void {
        this.on("memory_synced", callback);
    }

    public onMemoryDeleted(callback: (memoryId: UUID) => void): void {
        this.on("memory_deleted", callback);
    }
} 