import { elizaLogger, Memory, UUID, stringToUuid } from "@elizaos/core";
import { MemoryEvent } from "./types/memory-events";
import { ROOM_IDS } from "./constants";
import { EventEmitter } from "events";

/**
 * MessageBroker is responsible for broadcasting memory events to other processes.
 * It uses Eliza's built-in memory system rather than maintaining its own subscriptions.
 */
export class MessageBroker {
    private static instance: MessageBroker;
    private eventEmitter: EventEmitter;

    private constructor() {
        this.eventEmitter = new EventEmitter();
    }

    public static getInstance(): MessageBroker {
        if (!MessageBroker.instance) {
            MessageBroker.instance = new MessageBroker();
        }
        return MessageBroker.instance;
    }

    public on(event: string, callback: (...args: any[]) => void): void {
        this.eventEmitter.on(event, callback);
    }

    public emit(event: string, ...args: any[]): void {
        this.eventEmitter.emit(event, ...args);
    }

    public subscribe(event: string, callback: (...args: any[]) => void): void {
        this.eventEmitter.on(event, callback);
    }

    /**
     * Broadcast a memory event to other processes through the memory system
     */
    public async broadcast(event: MemoryEvent): Promise<void> {
        try {
            // Create memory for the event in the global room
            const memory: Memory = {
                id: stringToUuid(`event-${event.content.id}-${Date.now()}`),
                content: {
                    type: "memory_event",
                    ...event,
                    text: `Memory event: ${event.type} for ${event.content.type}`,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                roomId: ROOM_IDS.DAO,
                userId: event.agentId,
                agentId: event.agentId
            };

            // Let Eliza's memory system handle the distribution
            if (process.send) {
                process.send({
                    type: "memory_sync",
                    operation: "create",
                    memory,
                    timestamp: Date.now(),
                    processId: process.pid
                });
            }
        } catch (error) {
            elizaLogger.error("Error broadcasting memory event:", error);
            throw error;
        }
    }
} 