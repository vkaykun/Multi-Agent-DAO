// shared/types/subscriptionRegistry.ts

import { AgentType } from "./base";
import { DAOMemoryType } from "./memory";
import { UUID } from "@elizaos/core";

/**
 * Registry of required memory subscriptions for each agent type.
 * This ensures agents subscribe to all necessary memory types during initialization.
 */
export const SUBSCRIPTION_REGISTRY: Record<AgentType, DAOMemoryType[]> = {
    "TREASURY": [
        // Treasury-specific events
        "swap_request",
        "swap_execution_result",
        "deposit_received",
        "transfer_requested",
        "transaction_completed",
        "pending_transaction",
        "wallet_registration",
        "transaction_status_changed",
        // Response types
        "deposit_response",
        "register_response",
        "verify_response",
        "transfer_response",
        "balance_response",
        // Deposit handling
        "pending_deposit",
        "deposit_verified",
        "deposit_instructions",
        // Transaction records
        "treasury_transaction",
        "transaction", // Backward compatibility
        // Registration results
        "wallet_registration_result",
        // Cross-domain events treasury needs to handle
        "proposal_status_changed",
        "proposal_execution_result",
        "proposal", // Backward compatibility
        "proposal_created", // Backward compatibility
        "proposal_passed", // Backward compatibility
        "proposal_executed", // Backward compatibility
        "strategy_execution_request",
        "strategy_status_changed",
        "strategy_execution_result",
        // Generic conversation types - CRITICAL for maintaining context
        "message",
        "user_message",
        "agent_response",
        "user_interaction",
        "conversation_context"
    ],

    "USER": [
        // User-specific events
        "user_interaction",
        "user_preference_update",
        "user_feedback",
        "learning_update",
        "conversation_context",
        "task_tracking",
        "user_profile_update",
        // Cross-domain events user needs to handle
        "vote_cast",
        "proposal_status_changed",
        "proposal_execution_result",
        "strategy_status_changed",
        "wallet_registration",
        "wallet_registration_result",
        "strategy_execution_result",
        "deposit_received" // Track deposits to update user profiles
    ],

    "PROPOSAL": [
        // Proposal-specific events
        "proposal_created",
        "vote_cast",
        "proposal_status_changed",
        "proposal_execution_result"
    ],

    "STRATEGY": [
        // Strategy-specific events
        "position_update",
        "price_update",
        "strategy_execution_request",
        "strategy_status_changed",
        "strategy_execution_result",
        // Cross-domain events strategy needs to handle
        "swap_execution_result",
        "swap_completed", // Backward compatibility
        "proposal_status_changed",
        "proposal_execution_result",
        "proposal_passed", // Backward compatibility
        "proposal_executed" // Backward compatibility
    ]
} as const;

export interface AgentSubscription {
    id: UUID;
    agentId: UUID;
    type: string;
    status: "active" | "inactive";
    filters?: Record<string, any>;
    lastUpdated: number;
}

/**
 * Validates that an agent has all required memory subscriptions for its type
 */
export function validateAgentSubscriptions(
    agentType: AgentType,
    subscribedTypes: Set<string>
): { valid: boolean; missing: string[] } {
    const requiredSubscriptions = SUBSCRIPTION_REGISTRY[agentType];
    const missing = requiredSubscriptions.filter(type => !subscribedTypes.has(type));
    
    return {
        valid: missing.length === 0,
        missing
    };
}

/**
 * Validates the structure of agent subscription objects
 */
export function validateAgentSubscriptionStructure(subscriptions: AgentSubscription[]): boolean {
    if (!Array.isArray(subscriptions)) {
        return false;
    }

    return subscriptions.every(subscription => {
        return (
            typeof subscription === "object" &&
            subscription !== null &&
            typeof subscription.id === "string" &&
            typeof subscription.agentId === "string" &&
            typeof subscription.type === "string" &&
            (subscription.status === "active" || subscription.status === "inactive") &&
            (subscription.filters === undefined || typeof subscription.filters === "object") &&
            typeof subscription.lastUpdated === "number"
        );
    });
}

/**
 * Gets all required memory types for an agent type
 */
export function getRequiredMemoryTypes(agentType: AgentType): DAOMemoryType[] {
    return SUBSCRIPTION_REGISTRY[agentType];
}

/**
 * Checks if a memory type is required for an agent type
 */
export function isRequiredMemoryType(agentType: AgentType, memoryType: string): boolean {
    return SUBSCRIPTION_REGISTRY[agentType].includes(memoryType as DAOMemoryType);
}

/**
 * Gets all agent types that require a specific memory type
 */
export function getAgentsRequiringMemoryType(memoryType: DAOMemoryType): AgentType[] {
    return Object.entries(SUBSCRIPTION_REGISTRY)
        .filter(([_, types]) => types.includes(memoryType))
        .map(([agentType]) => agentType as AgentType);
} 