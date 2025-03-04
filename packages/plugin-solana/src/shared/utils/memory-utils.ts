import { MEMORY_DOMAINS } from '../constants.ts';

// Define explicit memory types
export enum MemoryType {
    ACTIVE = 'active',
    ARCHIVED = 'archived',
    DESCRIPTIVE = 'descriptive'
}

export function getMemoryDomain(type: string): string {
    // Use appropriate domain based on memory type
    if (type.startsWith('agent_') || type.endsWith('_agent')) {
        return MEMORY_DOMAINS.AGENTS;
    }
    if (type.startsWith('system_') || type.endsWith('_system')) {
        return MEMORY_DOMAINS.SYSTEM;
    }
    return MEMORY_DOMAINS.TRANSACTIONS;
}

export function shouldArchiveMemory(type: string, status?: string): boolean {
    // Simplify archival logic to just check status
    return status === "executed" || 
           status === "failed" || 
           status === "cancelled";
}

export function isDescriptiveMemory(type: string): boolean {
    // Simplify to check explicit descriptive types
    return type === MemoryType.DESCRIPTIVE;
}

// New helper to get memory type
export function getMemoryType(type: string, status?: string): MemoryType {
    if (shouldArchiveMemory(type, status)) {
        return MemoryType.ARCHIVED;
    }
    if (isDescriptiveMemory(type)) {
        return MemoryType.DESCRIPTIVE;
    }
    return MemoryType.ACTIVE;
} 