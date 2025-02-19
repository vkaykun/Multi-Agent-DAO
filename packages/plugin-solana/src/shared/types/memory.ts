import { UUID, Media, Content, stringToUuid, Memory as CoreMemory } from "@elizaos/core";
import { BaseContent, ContentStatus } from './base';

// Define global room IDs as UUID patterns
export const GLOBAL_ROOM_ID = "global-0000-0000-0000-000000000000" as UUID;
export const PROPOSAL_ROOM_ID = "proposal-0000-0000-0000-000000000000" as UUID;
export const TREASURY_ROOM_ID = "treasury-0000-0000-0000-000000000000" as UUID;
export const STRATEGY_ROOM_ID = "strategy-0000-0000-0000-000000000000" as UUID;

export type DAOMemoryType = 
    // Proposal related
    | "proposal"
    | "proposal_created"
    | "proposal_passed"
    | "proposal_rejected"
    | "proposal_executed"
    | "proposal_status_changed"
    | "vote_cast"
    | "close_vote_request"
    | "vote_recorded"
    
    // Strategy related
    | "strategy"
    | "strategy_created"
    | "strategy_triggered"
    | "strategy_execution"
    | "strategy_execution_request"
    | "strategy_execution_result"
    | "strategy_status_changed"
    | "strategy_cancellation"
    | "strategy_passed"
    | "strategy_rejected"
    | "strategy_executed"
    
    // Treasury related
    | "swap_request"
    | "swap_completed"
    | "swap_failed"
    | "deposit"
    | "deposit_received"
    | "transfer"
    | "transfer_requested"
    | "registration"
    | "wallet_registration"
    
    // Position/Market related
    | "position_update"
    | "price_update"
    
    // System related
    | "broadcast"
    | "memory_error"
    | "transaction_completed"
    | "pending_transaction";

export interface DAOMemoryContent extends BaseContent {
    type: DAOMemoryType;
    status: ContentStatus;
    metadata?: MemoryMetadata;
    id: UUID;
    text: string;
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
}

// Extend the core Memory interface to include domain
export interface Memory extends CoreMemory {
    domain: string;
}

// Memory pagination options
export interface PaginationOptions {
    pageSize?: number;
    cursor?: string;
    maxPages?: number;
    startTime?: number;
    endTime?: number;
}

// Memory query options
export interface MemoryQueryOptions {
    domain?: string;
    count?: number;
    unique?: boolean;
    start?: number;
    end?: number;
    cursor?: string;
    types?: string[];
}

// Memory creation helpers
export function createMemoryContent(
    type: DAOMemoryType,
    text: string,
    status: ContentStatus,
    metadata?: Partial<MemoryMetadata>,
    agentId?: UUID
): DAOMemoryContent {
    const now = Date.now();
    return {
        id: stringToUuid(`mem-${now}`),
        type,
        text,
        status,
        agentId: agentId || "system" as UUID,
        createdAt: now,
        updatedAt: now,
        metadata: {
            ...metadata,
            tags: metadata?.tags || [],
            priority: metadata?.priority || 'medium'
        }
    };
}

// Helper for creating strategy-specific memory content
export function createStrategyMemoryContent(
    type: Extract<DAOMemoryType, "strategy" | `strategy_${string}`>,
    text: string,
    status: ContentStatus,
    strategyId: string,
    metadata?: Partial<MemoryMetadata>,
    agentId?: UUID
): DAOMemoryContent {
    return createMemoryContent(
        type,
        text,
        status,
        {
            ...metadata,
            strategyId,
            tags: ["strategy", ...(metadata?.tags || [])],
            priority: metadata?.priority || "high"
        },
        agentId
    );
}

// Helper for creating proposal-specific memory content
export function createProposalMemoryContent(
    type: Extract<DAOMemoryType, "proposal" | `proposal_${string}`>,
    text: string,
    status: ContentStatus,
    proposalId: string,
    metadata?: Partial<MemoryMetadata>,
    agentId?: UUID
): DAOMemoryContent {
    return createMemoryContent(
        type,
        text,
        status,
        {
            ...metadata,
            proposalId,
            tags: ["proposal", ...(metadata?.tags || [])],
            priority: metadata?.priority || "high"
        },
        agentId
    );
}

// Remove this interface since we're using core's Memory
// export interface Memory {
//     userId: UUID;
//     content: BaseContent;
//     roomId: UUID;
//     agentId: UUID;
// } 

export interface MemoryMetadata {
    targetAgent?: UUID;
    action?: string;
    priority?: "low" | "medium" | "high";
    requiresResponse?: boolean;
    responseTimeout?: number;
    tags?: string[];
    strategyId?: string;
    proposalId?: string;
    proposer?: UUID;
    title?: string;
    description?: string;
    previousStatus?: ContentStatus;
    reason?: string;
    strategyStatus?: ContentStatus;
    fromToken?: string;
    toToken?: string;
    amount?: string;
    sourceMemory?: UUID;
    sourceType?: string;
    userId?: string;
    vote?: 'yes' | 'no';
    voteStats?: {
        totalVotes: number;
        yesVotes: number;
        noVotes: number;
        yesPercentage: number;
        quorumReached: boolean;
        minimumYesVotesReached: boolean;
        minimumPercentageReached: boolean;
    };
    requirements?: {
        quorum: number;
        minimumYesVotes: number;
        minimumVotePercentage: number;
    };
    isRollback?: boolean;
    originalContentId?: UUID;
    rollbackReason?: string;
    version?: number;
    previousVersion?: number;
    versionTimestamp?: number;
    versionReason?: string;
    versionHistory?: Array<{
        version: number;
        timestamp: number;
        reason: string;
    }>;
    // Error-related fields
    memoryType?: string;
    error?: string;
    errorDetails?: Record<string, unknown>;
    [key: string]: unknown;  // Add index signature
} 