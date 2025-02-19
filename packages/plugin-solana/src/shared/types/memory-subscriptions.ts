import { Memory } from "@elizaos/core";
import { AgentType } from "./base";

export interface MemorySubscriptionHandler {
    (memory: Memory): Promise<void>;
}

export interface MemorySubscriptionConfig {
    type: string;
    description: string;
    requiredBy: AgentType[];
    handler: MemorySubscriptionHandler;
    priority?: "high" | "medium" | "low";
    dependencies?: string[];  // Other memory types this handler depends on
}

/**
 * Registry of all memory subscriptions in the system.
 * Each entry defines which agents need to subscribe to which memory types.
 */
export const MEMORY_SUBSCRIPTIONS: Record<string, MemorySubscriptionConfig> = {
    // Deposit-related subscriptions
    "deposit_received": {
        type: "deposit_received",
        description: "New deposits to treasury",
        requiredBy: ["TREASURY", "USER"],  // Both TREASURY and USER need this
        handler: async (memory) => {
            // Handled by both TreasuryAgent.handleDeposit and UserProfileAgent.handleDeposit
        },
        priority: "high"
    },

    // Proposal-related subscriptions
    "proposal": {
        type: "proposal",
        description: "Core proposal creation and updates",
        requiredBy: ["PROPOSAL"],
        handler: async (memory) => {
            // Handled by ProposalAgent.handleProposal
        }
    },
    "vote_cast": {
        type: "vote_cast",
        description: "Vote submissions on proposals",
        requiredBy: ["PROPOSAL", "USER"],  // Both PROPOSAL and USER need this
        handler: async (memory) => {
            // Handled by both agents
        },
        dependencies: ["proposal"]
    },
    "proposal_execution_result": {
        type: "proposal_execution_result",
        description: "Results of proposal execution",
        requiredBy: ["PROPOSAL", "TREASURY", "USER"],  // All three need this
        handler: async (memory) => {
            // Handled by all three agents
        }
    },

    // Treasury-related subscriptions
    "swap_request": {
        type: "swap_request",
        description: "Token swap requests",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent.handleSwapRequest
        }
    },
    "transfer_requested": {
        type: "transfer_requested",
        description: "Token transfer requests",
        requiredBy: ["TREASURY"],
        handler: async (memory) => {
            // Handled by TreasuryAgent.handleTransfer
        }
    },

    // Strategy-related subscriptions
    "strategy_triggered": {
        type: "strategy_triggered",
        description: "Strategy execution triggers",
        requiredBy: ["STRATEGY", "TREASURY"],
        handler: async (memory) => {
            // Handled by both agents
        }
    },
    "price_update": {
        type: "price_update",
        description: "Token price updates",
        requiredBy: ["STRATEGY"],
        handler: async (memory) => {
            // Handled by StrategyAgent.handlePriceUpdate
        }
    },
    "position_update": {
        type: "position_update",
        description: "Strategy position updates",
        requiredBy: ["STRATEGY"],
        handler: async (memory) => {
            // Handled by StrategyAgent.handlePositionUpdate
        }
    },

    // User-related subscriptions
    "wallet_registration": {
        type: "wallet_registration",
        description: "User wallet registration events",
        requiredBy: ["USER"],
        handler: async (memory) => {
            // Handled by UserProfileAgent.handleWalletRegistration
        },
        priority: "high"
    }
}; 