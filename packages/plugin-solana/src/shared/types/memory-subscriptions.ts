import { Memory } from "@elizaos/core";
import { AgentType } from "./base.ts";

export interface MemorySubscriptionConfig {
    type: string;
    priority?: "high" | "medium" | "low";
    versioning?: boolean;
    unique?: boolean;
}

export interface AgentSubscription extends MemorySubscriptionConfig {
    description?: string;
    requiredBy?: AgentType[];
    handledBy?: Partial<Record<AgentType, string>>;
    dependencies?: string[];
}

export type DAOMemoryType = string;

// Define memory subscriptions
export const MEMORY_SUBSCRIPTIONS: Record<DAOMemoryType, AgentSubscription> = {
    // Proposal-related subscriptions
    "proposal": {
        type: "proposal",
        description: "Legacy proposal creation and management",
        requiredBy: ["PROPOSAL", "TREASURY"],
        priority: "medium",
        versioning: false,
        unique: true,
        handledBy: {
            PROPOSAL: "Initializes and manages proposals",
            TREASURY: "Processes proposal-related treasury operations"
        }
    },
    "proposal_created": {
        type: "proposal_created",
        description: "New proposal creation events",
        requiredBy: ["PROPOSAL", "TREASURY"],
        priority: "medium",
        versioning: false,
        unique: true,
        handledBy: {
            PROPOSAL: "Initializes proposal tracking and validation",
            TREASURY: "Processes proposal creation events for treasury operations"
        }
    },
    // Add backward compatibility types
    "proposal_passed": {
        type: "proposal_passed",
        description: "Legacy event for proposals that have passed voting",
        requiredBy: ["TREASURY", "STRATEGY"],
        priority: "high",
        versioning: false,
        unique: true,
        handledBy: {
            TREASURY: "Executes passed proposals",
            STRATEGY: "Monitors strategy-related proposals"
        }
    },
    "proposal_executed": {
        type: "proposal_executed",
        description: "Legacy event for proposals that have been executed",
        requiredBy: ["TREASURY", "STRATEGY"],
        priority: "high",
        versioning: false,
        unique: false,
        handledBy: {
            TREASURY: "Updates state after proposal execution",
            STRATEGY: "Updates strategy state after proposal execution"
        }
    },
    "transaction": {
        type: "transaction",
        description: "Legacy generic transaction record",
        requiredBy: ["TREASURY"],
        priority: "medium",
        versioning: true,
        unique: true,
        handledBy: {
            TREASURY: "Tracks treasury transactions"
        }
    },
    // Nova-specific subscriptions
    "user_interaction": {
        type: "user_interaction",
        description: "User interactions and commands",
        requiredBy: ["USER", "TREASURY"],
        priority: "high",
        handledBy: {
            USER: "Updates user interaction history and triggers response generation",
            TREASURY: "Processes user commands and interactions for treasury operations"
        }
    },
    "user_preference_update": {
        type: "user_preference_update",
        description: "Updates to user preferences and settings",
        requiredBy: ["USER"],
        priority: "medium",
        handledBy: {
            USER: "Updates stored user preferences and triggers relevant adaptations"
        }
    },
    "user_feedback": {
        type: "user_feedback",
        description: "User feedback and ratings",
        requiredBy: ["USER"],
        handledBy: {
            USER: "Records feedback and updates user satisfaction metrics"
        }
    },
    "learning_update": {
        type: "learning_update",
        description: "Updates to Nova's learning and adaptation",
        requiredBy: ["USER"],
        handledBy: {
            USER: "Updates learning models and adaptation parameters"
        }
    },
    "conversation_context": {
        type: "conversation_context",
        description: "Contextual information for conversations",
        requiredBy: ["USER", "TREASURY"],
        priority: "high",
        handledBy: {
            USER: "Updates conversation state and context tracking",
            TREASURY: "Maintains conversation context for treasury operations"
        }
    },
    "task_tracking": {
        type: "task_tracking",
        description: "User task and goal tracking",
        requiredBy: ["USER"],
        handledBy: {
            USER: "Updates task progress and goal completion status"
        }
    },
    "vote_cast": {
        type: "vote_cast",
        description: "Vote submissions on proposals with vote status in metadata",
        requiredBy: ["PROPOSAL", "USER"],
        dependencies: ["proposal"],
        priority: "high",
        handledBy: {
            PROPOSAL: "Records vote and updates proposal stats",
            USER: "Updates user voting history"
        }
    },
    "proposal_status_changed": {
        type: "proposal_status_changed",
        description: "Proposal status changes (including passed, rejected, etc.)",
        requiredBy: ["PROPOSAL", "STRATEGY", "TREASURY", "USER"],
        priority: "high",
        dependencies: ["proposal"],
        handledBy: {
            PROPOSAL: "Updates proposal state and triggers next steps",
            STRATEGY: "Handles execution phase for strategy-related proposals",
            TREASURY: "Processes treasury-related proposal executions",
            USER: "Updates user stats based on proposal outcomes"
        }
    },
    "proposal_execution_result": {
        type: "proposal_execution_result",
        description: "Results of proposal execution (success/failure, tx hash, etc.)",
        requiredBy: ["PROPOSAL", "STRATEGY", "TREASURY", "USER"],
        priority: "high",
        dependencies: ["proposal", "proposal_status_changed"],
        handledBy: {
            PROPOSAL: "Updates proposal state based on execution result",
            STRATEGY: "Triggers post-execution strategy logic",
            TREASURY: "Updates treasury state after execution",
            USER: "Updates user stats based on execution result"
        }
    },
    // Strategy-related subscriptions
    "strategy_execution_request": {
        type: "strategy_execution_request",
        description: "Request to execute a strategy",
        requiredBy: ["STRATEGY", "TREASURY"],
        priority: "high",
        dependencies: ["strategy"],
        handledBy: {
            STRATEGY: "Validates and prepares strategy for execution",
            TREASURY: "Handles the actual execution via swap"
        }
    },
    "strategy_status_changed": {
        type: "strategy_status_changed",
        description: "Strategy status updates (triggered, executing, etc)",
        requiredBy: ["STRATEGY", "TREASURY", "USER"],
        priority: "high",
        dependencies: ["strategy", "strategy_execution_request"],
        handledBy: {
            STRATEGY: "Updates strategy state and monitoring",
            TREASURY: "Tracks strategy execution progress",
            USER: "Updates user strategy stats"
        }
    },
    "strategy_execution_result": {
        type: "strategy_execution_result",
        description: "Final result of strategy execution",
        requiredBy: ["STRATEGY", "TREASURY", "USER"],
        priority: "high",
        dependencies: ["strategy", "strategy_status_changed"],
        handledBy: {
            STRATEGY: "Updates strategy state based on result",
            TREASURY: "Updates treasury state after execution",
            USER: "Updates user strategy stats"
        }
    },
    // Treasury-related subscriptions
    "swap_request": {
        type: "swap_request",
        description: "Token swap requests",
        requiredBy: ["TREASURY"],
        priority: "high",
        versioning: false,
        unique: true,
        handledBy: {
            TREASURY: "Processes token swap requests"
        }
    },
    "swap_execution_result": {
        type: "swap_execution_result",
        description: "Results of swap execution (success/failure)",
        requiredBy: ["TREASURY", "STRATEGY"],
        priority: "high",
        dependencies: ["swap_request"],
        handledBy: {
            TREASURY: "Updates treasury state after swap",
            STRATEGY: "Updates strategy if swap was strategy-triggered"
        }
    },
    "deposit_received": {
        type: "deposit_received",
        description: "New deposits to treasury",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Processes and verifies incoming deposits"
        }
    },
    "transfer_requested": {
        type: "transfer_requested",
        description: "Token transfer requests",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Processes and executes token transfers"
        }
    },
    "transaction_status_changed": {
        type: "transaction_status_changed",
        description: "Transaction status updates",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Updates transaction tracking and state"
        }
    },
    "transaction_completed": {
        type: "transaction_completed",
        description: "Transaction completion events",
        requiredBy: ["TREASURY"],
        priority: "high",
        handledBy: {
            TREASURY: "Finalizes transaction processing"
        }
    },
    "pending_transaction": {
        type: "pending_transaction",
        description: "Pending transaction events",
        requiredBy: ["TREASURY"],
        priority: "high",
        handledBy: {
            TREASURY: "Tracks and monitors pending transactions"
        }
    },
    // Position/Market-related subscriptions
    "position_update": {
        type: "position_update",
        description: "Strategy position updates",
        requiredBy: ["STRATEGY"],
        handledBy: {
            STRATEGY: "Updates position tracking and triggers strategy logic"
        }
    },
    "price_update": {
        type: "price_update",
        description: "Token price updates",
        requiredBy: ["STRATEGY"],
        handledBy: {
            STRATEGY: "Updates price tracking and triggers strategy checks"
        }
    },
    // User-related subscriptions
    "wallet_registration": {
        type: "wallet_registration",
        description: "User wallet registration events",
        requiredBy: ["USER", "TREASURY"],
        priority: "high",
        handledBy: {
            USER: "Updates user profile with wallet information",
            TREASURY: "Tracks registered wallets for treasury operations"
        }
    },
    "user_profile_update": {
        type: "user_profile_update",
        description: "Updates to user profile information",
        requiredBy: ["USER"],
        priority: "medium",
        handledBy: {
            USER: "Updates stored user profile data"
        }
    },
    // Additional Treasury-related subscriptions
    "pending_deposit": {
        type: "pending_deposit",
        description: "Deposits awaiting verification",
        requiredBy: ["TREASURY"],
        priority: "high",
        dependencies: ["deposit_received"],
        handledBy: {
            TREASURY: "Tracks and verifies pending deposits before processing"
        }
    },
    "deposit_verified": {
        type: "deposit_verified",
        description: "Successfully verified deposits",
        requiredBy: ["TREASURY"],
        priority: "high",
        dependencies: ["pending_deposit"],
        handledBy: {
            TREASURY: "Processes verified deposits and updates balances"
        }
    },
    "deposit_instructions": {
        type: "deposit_instructions",
        description: "Instructions for making deposits",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Provides deposit instructions to users"
        }
    },
    "deposit_response": {
        type: "deposit_response",
        description: "Responses to deposit-related actions",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Handles responses to deposit actions and verifications"
        }
    },
    "register_response": {
        type: "register_response",
        description: "Responses to wallet registration attempts",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Handles responses to wallet registration actions"
        }
    },
    "wallet_registration_result": {
        type: "wallet_registration_result",
        description: "Results of wallet registration attempts",
        requiredBy: ["TREASURY", "USER"],
        priority: "high",
        dependencies: ["wallet_registration"],
        handledBy: {
            TREASURY: "Processes wallet registration results",
            USER: "Updates user profile with registration outcome"
        }
    },
    "balance_response": {
        type: "balance_response",
        description: "Responses to balance check requests",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Provides treasury balance information"
        }
    },
    "treasury_transaction": {
        type: "treasury_transaction",
        description: "Treasury transaction records",
        requiredBy: ["TREASURY"],
        priority: "high",
        handledBy: {
            TREASURY: "Records and tracks treasury transactions"
        }
    },
    "verify_response": {
        type: "verify_response",
        description: "Responses to verification requests",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Handles responses to verification actions"
        }
    },
    "transfer_response": {
        type: "transfer_response",
        description: "Responses to transfer requests",
        requiredBy: ["TREASURY"],
        handledBy: {
            TREASURY: "Handles responses to transfer actions"
        }
    },
    // Add backward compatibility type
    "swap_completed": {
        type: "swap_completed",
        description: "Legacy event for completed token swaps",
        requiredBy: ["TREASURY", "STRATEGY"],
        priority: "high",
        versioning: false,
        unique: true,
        handledBy: {
            TREASURY: "Updates treasury state after swap completion",
            STRATEGY: "Updates strategy state based on swap results"
        }
    },
    // Add generic conversation types
    "message": {
        type: "message",
        description: "Generic user message",
        requiredBy: ["USER", "TREASURY"],
        priority: "high",
        versioning: false,
        unique: false,
        handledBy: {
            TREASURY: "Handles normal conversation if needed",
            USER: "User agent processes messages"
        }
    },
    "user_message": {
        type: "user_message",
        description: "Messages originating from users",
        requiredBy: ["USER", "TREASURY"],
        priority: "high",
        versioning: false,
        unique: false,
        handledBy: {
            TREASURY: "Processes user messages for conversation",
            USER: "Updates user interaction history"
        }
    },
    "agent_response": {
        type: "agent_response",
        description: "Responses generated by agents",
        requiredBy: ["USER", "TREASURY"],
        priority: "medium",
        versioning: false,
        unique: false,
        handledBy: {
            TREASURY: "Tracks agent responses for conversation context",
            USER: "Records agent responses for user history"
        }
    }
} as const; 