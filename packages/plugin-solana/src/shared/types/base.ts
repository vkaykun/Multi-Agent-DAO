import { Content, UUID, ServiceType as CoreServiceType, IMemoryManager as CoreMemoryManager, IAgentRuntime as CoreAgentRuntime } from "@elizaos/core";
import { Memory } from "./memory-types";
import { MemoryQueryOptions } from './memory';
import { ProposalType } from "./proposal";

// Define our own memory manager interface with all required methods
export interface IMemoryManager extends CoreMemoryManager {
    on(type: string, callback: (memory: any) => Promise<void>): void;
    off(type: string, callback: (memory: any) => Promise<void>): void;
    emit?(type: string, memory: any): void;
}

// Extend the core memory manager with event methods
export type ExtendedMemoryManager = CoreMemoryManager & {
    on(type: string, callback: (memory: any) => Promise<void>): void;
    off(type: string, callback: (memory: any) => Promise<void>): void;
    emit?(type: string, memory: any): void;
}

// Use the extended memory manager in the runtime interface
export interface IAgentRuntime extends CoreAgentRuntime {
    messageManager: ExtendedMemoryManager;
}

// Define all possible statuses with clear descriptions
export const VALID_CONTENT_STATUSES = [
    "draft",             // Initial state when content is created
    "open",              // Open for voting/active
    "pending_execution", // Passed validation, waiting for execution
    "executing",         // Currently being executed
    "executed",          // Successfully executed
    "rejected",          // Failed validation/vote
    "cancelled",         // Manually cancelled
    "failed"            // Execution failed
] as const;

export type BaseContentStatus = typeof VALID_CONTENT_STATUSES[number];
export type ContentStatus = BaseContentStatus;

// Define status groups for semantic meaning
export const STATUS_GROUPS = {
    INITIAL: ["draft"] as const,
    ACTIVE: ["open", "pending_execution", "executing"] as const,
    TERMINAL: ["executed", "rejected", "cancelled", "failed"] as const,
    REQUIRES_ACTION: ["pending_execution", "failed"] as const,
    SUCCESSFUL: ["executed"] as const
} as const;

// Define valid transitions with metadata and validation
export const VALID_STATUS_TRANSITIONS: Record<ContentStatus, {
    allowedTransitions: ContentStatus[];
    requiresCheck?: (content: BaseContent) => boolean;
    description: string;
    validForTypes: string[];  // Which content types can use this transition
    sideEffects?: string[];   // What other content might be affected
}> = {
    "draft": {
        allowedTransitions: ["open", "cancelled"],
        description: "Initial content state, can be opened or cancelled",
        validForTypes: ["proposal", "strategy"],
        sideEffects: []
    },
    "open": {
        allowedTransitions: ["pending_execution", "rejected", "cancelled"],
        requiresCheck: (content) => {
            // Check based on content type
            switch(content.type) {
                case "proposal":
                    const proposal = content as ProposalContent;
                    return proposal.voteStats?.quorumReached && 
                           proposal.voteStats?.minimumYesVotesReached &&
                           proposal.voteStats?.minimumPercentageReached;
                case "strategy":
                    return true; // Strategies can always transition from open
                default:
                    return false;
            }
        },
        description: "Active state, can move to pending execution if requirements met",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer"],
        sideEffects: ["strategy_status", "treasury_balance"]
    },
    "pending_execution": {
        allowedTransitions: ["executing", "cancelled", "failed"],
        description: "Validated and waiting for execution",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer"],
        sideEffects: ["strategy_status", "treasury_balance"]
    },
    "executing": {
        allowedTransitions: ["executed", "failed"],
        description: "Currently being executed",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer"],
        sideEffects: ["strategy_status", "treasury_balance", "user_profile"]
    },
    "executed": {
        allowedTransitions: [],
        description: "Terminal state: Successfully executed",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer", "deposit"],
        sideEffects: ["user_profile", "treasury_balance"]
    },
    "rejected": {
        allowedTransitions: [],
        description: "Terminal state: Failed validation/voting",
        validForTypes: ["proposal", "strategy"],
        sideEffects: ["strategy_status"]
    },
    "cancelled": {
        allowedTransitions: [],
        description: "Terminal state: Manually cancelled",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer"],
        sideEffects: ["strategy_status", "treasury_balance"]
    },
    "failed": {
        allowedTransitions: ["pending_execution", "cancelled"],
        description: "Execution failed, can retry or cancel",
        validForTypes: ["proposal", "strategy", "swap_request", "transfer"],
        sideEffects: ["strategy_status", "treasury_balance"]
    }
} as const;

// Helper functions for status management
export function isInGroup(status: ContentStatus, group: keyof typeof STATUS_GROUPS): boolean {
    return (STATUS_GROUPS[group] as readonly ContentStatus[]).includes(status);
}

export function isTerminalState(status: ContentStatus): boolean {
    return isInGroup(status, "TERMINAL");
}

export function requiresAction(status: ContentStatus): boolean {
    return isInGroup(status, "REQUIRES_ACTION");
}

export function isValidContentStatus(status: string): status is ContentStatus {
    return VALID_CONTENT_STATUSES.includes(status as ContentStatus);
}

export function isValidForType(status: ContentStatus, type: string): boolean {
    return VALID_STATUS_TRANSITIONS[status].validForTypes.includes(type);
}

export function isValidStatusTransition(
    from: ContentStatus, 
    to: ContentStatus, 
    content?: BaseContent
): {
    valid: boolean;
    reason?: string;
    sideEffects?: string[];
} {
    // Check if content type is valid for both statuses
    if (content && (!isValidForType(from, content.type) || !isValidForType(to, content.type))) {
        return {
            valid: false,
            reason: `Status '${from}' or '${to}' not valid for content type '${content.type}'`
        };
    }

    // Check if source state is terminal
    if (isTerminalState(from)) {
        return {
            valid: false,
            reason: `Cannot transition from terminal state '${from}'`
        };
    }

    const transitionConfig = VALID_STATUS_TRANSITIONS[from];
    if (!transitionConfig.allowedTransitions.includes(to)) {
        return {
            valid: false,
            reason: `Invalid transition from '${from}' to '${to}'. Allowed transitions: ${transitionConfig.allowedTransitions.join(", ")}`
        };
    }

    // If transition requires additional checks and content is provided
    if (transitionConfig.requiresCheck && content) {
        const checkPassed = transitionConfig.requiresCheck(content);
        if (!checkPassed) {
            return {
                valid: false,
                reason: `Transition requirements not met for '${from}' to '${to}'`
            };
        }
    }

    // Return success with any side effects
    return { 
        valid: true,
        sideEffects: VALID_STATUS_TRANSITIONS[to].sideEffects
    };
}

// Helper to get all possible transitions for a content type
export function getValidTransitionsForType(type: string): Map<ContentStatus, ContentStatus[]> {
    const transitions = new Map<ContentStatus, ContentStatus[]>();
    
    for (const [from, config] of Object.entries(VALID_STATUS_TRANSITIONS)) {
        if (config.validForTypes.includes(type)) {
            transitions.set(
                from as ContentStatus,
                config.allowedTransitions.filter(to => 
                    VALID_STATUS_TRANSITIONS[to].validForTypes.includes(type)
                )
            );
        }
    }
    
    return transitions;
}

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
    userStats?: {
        proposalsCreated: number;
        votesCount: number;
        strategiesCreated?: number;
        swapsExecuted?: number;
        depositsProcessed?: number;
        transfersProcessed?: number;
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
    // Swap-related fields
    swapId?: UUID;
    success?: boolean;
    executedBy?: UUID;
    timestamp?: number;
    inputToken?: string;
    outputToken?: string;
    inputAmount?: string;
    outputAmount?: string;
    // Proposal-specific metadata
    swapDetails?: {
        maxSlippage?: number;
        minOutputAmount?: number;
    };
    parameterName?: string;
    currentValue?: string | number;
    proposedValue?: string | number;
    effectiveDate?: number;
    target?: string;
    customType?: string;
    parameters?: Record<string, unknown>;
    proposalType?: ProposalType;
    sourceId?: UUID;
    sourceAgent?: string;
    [key: string]: unknown;
}

// Add agent-specific configuration types
export interface BaseAgentConfig {
    type: AgentType;
    capabilities?: string[];
    permissions?: string[];
    settings?: Record<string, unknown>;
}

export interface ProposalAgentConfig extends BaseAgentConfig {
    type: typeof AgentTypes.PROPOSAL;
    settings?: {
        quorumThreshold?: number;
        votingPeriod?: number;
        minimumVotes?: number;
        proposalTypes?: string[];
    };
}

export interface TreasuryAgentConfig extends BaseAgentConfig {
    type: typeof AgentTypes.TREASURY;
    settings?: {
        maxSwapAmount?: number;
        allowedTokens?: string[];
        slippageTolerance?: number;
        riskParameters?: {
            maxPositionSize?: number;
            maxDrawdown?: number;
        };
    };
}

export interface StrategyAgentConfig extends BaseAgentConfig {
    type: typeof AgentTypes.STRATEGY;
    settings?: {
        defaultTakeProfit?: number;
        defaultStopLoss?: number;
        maxStrategiesPerToken?: number;
        priceMonitoringInterval?: number;
    };
}

export type AgentConfig = ProposalAgentConfig | TreasuryAgentConfig | StrategyAgentConfig;

// Update character mapping to be more explicit
export type CharacterName = "Pion" | "Vela" | "Kron";

// Define AgentType as a string literal type to match runtime
export type AgentType = "PROPOSAL" | "TREASURY" | "STRATEGY" | "USER";

// Constants for agent types
export const AgentTypes = {
    PROPOSAL: "PROPOSAL",
    TREASURY: "TREASURY",
    STRATEGY: "STRATEGY",
    USER: "USER"
} as const satisfies Record<string, AgentType>;

// Update CHARACTER_AGENT_MAPPING to use string literals
export const CHARACTER_AGENT_MAPPING: Record<CharacterName, AgentType> = {
    "Pion": "PROPOSAL",
    "Vela": "TREASURY",
    "Kron": "STRATEGY"
} as const;

// Required memory types for each agent
export const REQUIRED_MEMORY_TYPES = {
    PROPOSAL: [
        "proposal_created",
        "vote_cast",
        "proposal_executed",
        "proposal_execution_result"
    ],
    TREASURY: [
        "swap_request",
        "proposal_passed",
        "strategy_triggered",
        "deposit_received",
        "transfer_requested"
    ],
    STRATEGY: [
        "position_update",
        "price_update",
        "strategy_execution_result",
        "strategy_execution",
        "swap_completed",
        "swap_failed"
    ],
    USER: [
        "wallet_registration",
        "deposit_received",
        "vote_cast",
        "proposal_created",
        "strategy_execution_result"
    ]
} as const;

// Memory type for each agent
export type ProposalMemoryType = typeof REQUIRED_MEMORY_TYPES.PROPOSAL[number];
export type TreasuryMemoryType = typeof REQUIRED_MEMORY_TYPES.TREASURY[number];
export type StrategyMemoryType = typeof REQUIRED_MEMORY_TYPES.STRATEGY[number];

// All memory types
export type DAOMemoryType = ProposalMemoryType | TreasuryMemoryType | StrategyMemoryType;

// Update BaseContent to include metadata and enforce memory types
export interface BaseContent extends Content {
    id: UUID;
    type: string;
    text: string;
    agentId: UUID;
    createdAt: number;
    updatedAt: number;
    status: ContentStatus;
    metadata?: MemoryMetadata;
}

export interface AgentMessage {
    type: string;
    content: BaseContent;
    from?: AgentType;
    to?: AgentType | "ALL";
    characterName?: CharacterName;
    global?: boolean; // Whether the message should be stored in the global room
    priority?: "low" | "medium" | "high";
    timestamp?: number;
}

export interface AgentAction<T extends BaseContent> {
    validate: (content: T) => Promise<boolean>;
    execute: (content: T) => Promise<boolean>;
    rollback?: (content: T) => Promise<boolean>;
}

export interface AgentCapability {
    name: string;
    description: string;
    requiredPermissions: string[];
    actions: string[];
}

export interface AgentState {
    id: UUID;
    type: AgentType;
    status: "active" | "inactive" | "error" | "initializing";
    capabilities: AgentCapability[];
    lastActive: number;
    currentAction?: string;
    error?: string;
}

export type DAOEventType = 
    | "proposal_created"
    | "proposal_passed"
    | "proposal_rejected"
    | "proposal_executed"
    | "strategy_triggered"
    | "strategy_executed"
    | "swap_requested"
    | "swap_completed"
    | "swap_failed"
    | "position_updated"
    | "treasury_updated";

export interface DAOEvent extends BaseContent {
    type: DAOEventType;
    eventId: string;
    timestamp: number;
    sourceAgent: AgentType;
    sourceId: string;
    details: any;
}

export interface SwapRequest extends BaseContent {
    type: "swap_request";
    fromToken: string;
    toToken: string;
    amount: string;
    reason: "strategy_triggered" | "proposal_passed" | "manual";
    requestId: string;
    sourceAgent: AgentType;
    sourceId: string;  // Strategy ID or Proposal ID
}

// Extend the core ServiceType
export type ServiceType = CoreServiceType | "STRATEGY_EXECUTOR" | "TEXT_GENERATION";

export const ServiceType = {
    ...CoreServiceType,
    STRATEGY_EXECUTOR: "STRATEGY_EXECUTOR",
    TEXT_GENERATION: "TEXT_GENERATION"
} as const;

export interface Transaction {
    commit(): Promise<void>;
    rollback(): Promise<void>;
}

// Memory uniqueness configuration
export const UNIQUE_MEMORY_TYPES = {
    // Core state records - Always unique by ID
    "proposal": {
        uniqueBy: ["id"],
        description: "Core proposal record"
    },
    "strategy": {
        uniqueBy: ["id"],
        description: "Core strategy record"
    },
    "treasury_transaction": {
        uniqueBy: ["txHash"],
        description: "Unique transaction record"
    },
    "agent_state": {
        uniqueBy: ["agentId"],
        description: "Current state for each agent"
    },
    "wallet_registration": {
        uniqueBy: ["userId", "walletAddress"],
        description: "One registration per wallet per user"
    },
    "user_profile": {
        uniqueBy: ["userId"],
        description: "One profile per user"
    },

    // Voting records - Unique per user per proposal
    "vote": {
        uniqueBy: ["userId", "metadata.proposalId"],
        description: "One vote per user per proposal"
    },

    // Execution records - Unique per operation
    "strategy_execution": {
        uniqueBy: ["strategyId", "executionId"],
        description: "Unique execution record per strategy operation"
    },
    "proposal_execution": {
        uniqueBy: ["proposalId", "executionId"],
        description: "Unique execution record per proposal"
    }
} as const;

// Types that should maintain history (non-unique)
export const VERSIONED_MEMORY_TYPES = [
    "proposal_draft",       // Keep draft history
    "strategy_update",      // Track strategy modifications
    "price_update",         // Price history
    "position_update",      // Position changes over time
    "treasury_update",      // Treasury state changes
    "agent_message",        // Communication history
    "agent_action",         // Action history
    "memory_error"         // Error logs
] as const;

// Helper to check if a memory type should be unique
export function isUniqueMemoryType(type: string): type is keyof typeof UNIQUE_MEMORY_TYPES {
    return type in UNIQUE_MEMORY_TYPES;
}

// Helper to check if a memory type should maintain history
export function isVersionedMemoryType(type: string): boolean {
    return VERSIONED_MEMORY_TYPES.includes(type as any);
}

export interface Vote {
    userId: string;
    votingPower: number;
    timestamp: number;
}

export interface VoteStats {
    total: number;
    yes: number;
    no: number;
    totalVotingPower: number;
    totalYesPower: number;
    totalNoPower: number;
    yesPowerPercentage: number;
    yesPercentage: number;
    quorumReached: boolean;
    minimumYesVotesReached: boolean;
    minimumPercentageReached: boolean;
}

export interface ProposalContent extends BaseContent {
    type: "proposal";
    title: string;
    description: string;
    proposer: string;
    yes: Vote[];
    no: Vote[];
    voteStats: VoteStats;
    status: "draft" | "open" | "pending_execution" | "executing" | "executed" | "rejected" | "cancelled" | "failed";
    createdAt: number;
    updatedAt: number;
}

// Add UserProfile interface
export interface UserProfile extends BaseContent {
    type: "user_profile";
    userId: UUID;
    proposalsCreated: number;
    votesCount: number;
    lastActive: number;
    reputation: number;
    votingPower: number;
    roles: string[];
    walletAddresses?: string[];
    totalDeposits?: number;
    metadata: MemoryMetadata & {
        lastProposalId?: string;
        lastVoteId?: string;
        userStats?: {
            proposalsCreated: number;
            votesCount: number;
            strategiesCreated?: number;
            swapsExecuted?: number;
            depositsProcessed?: number;
            transfersProcessed?: number;
        };
    };
}

// Add StrategyExecutionResult type
export interface StrategyExecutionResult extends BaseContent {
    type: "strategy_execution_result";
    requestId: UUID;
    success: boolean;
    strategyId: UUID;
    executedAmount?: string;
    executionPrice?: string;
    txSignature?: string;
    error?: string;
}

// Add to IDatabaseAdapter interface
export interface IDatabaseAdapter {
    // ... existing methods ...

    /** Set transaction isolation level */
    setIsolationLevel?(level: 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE'): Promise<void>;

    /** Get paginated memories */
    getMemoriesWithPagination(params: {
        roomId: UUID;
        limit?: number;
        cursor?: UUID;
        startTime?: number;
        endTime?: number;
        tableName: string;
        agentId: UUID;
    }): Promise<{ items: Memory[]; hasMore: boolean; nextCursor?: UUID; }>;
}

// Add to ICacheManager interface
export interface CacheOptions {
    expires?: number;
    onlyIfNotExists?: boolean;  // Only set if key doesn't exist
    onlyIfValue?: unknown;      // Only set if current value matches
}

export interface VoteContent extends BaseContent {
    type: "vote";
    proposalId: UUID;
    vote: "yes" | "no";
    metadata: MemoryMetadata & {
        proposalId: string;
        vote: "yes" | "no";
        reason?: string;
    };
}

export interface SwapDetails {
    type: "swap";
    inputToken: string;
    outputToken: string;
    amount: string;
    maxSlippage?: number;
    minOutputAmount?: string;
}

export interface SwapTransaction extends BaseContent {
    type: "swap_completed" | "swap_failed";
    id: UUID;
    swapId: UUID;
    error?: string;
    txHash?: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount?: string;
}

export enum ContentStatusIndex {
    DRAFT = "draft",
    OPEN = "open",
    PENDING_EXECUTION = "pending_execution",
    EXECUTING = "executing",
    EXECUTED = "executed",
    REJECTED = "rejected",
    CANCELLED = "cancelled",
    FAILED = "failed"
}

export function getContentStatus(index: ContentStatusIndex): ContentStatus {
    return index;
} 