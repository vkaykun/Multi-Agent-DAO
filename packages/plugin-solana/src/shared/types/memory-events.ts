import { Memory, UUID } from "@elizaos/core";
import { BaseContent } from "./base";

export interface MemoryEvent {
    type: "memory_created" | "memory_updated" | "memory_deleted";
    content: BaseContent;
    roomId: UUID;
    agentId: UUID;
    timestamp: number;
}

export interface MemorySubscription {
    type: string;
    callback: (memory: Memory) => Promise<void>;
}

export interface MemoryBroadcastOptions {
    skipProcess?: UUID;  // Skip broadcasting to specific process
    targetRooms?: UUID[];  // Only broadcast to specific rooms
} 