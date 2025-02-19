import { UUID } from "@elizaos/core";
import { BaseContent } from "./base";
import { TokenBalance } from "./treasury";

export interface UserProfile extends BaseContent {
    type: "user_profile";
    userId: UUID;
    discordId?: string;
    walletAddresses: string[];
    primaryWallet?: string;
    totalDeposits: TokenBalance[];
    reputation: number;
    roles: string[];
    votingPower: number;
    lastActive: number;
    createdAt: number;
    updatedAt: number;
}

export interface UserProfileUpdate extends BaseContent {
    type: "user_profile_update";
    userId: UUID;
    updates: Partial<UserProfile>;
}

export interface UserActivityLog extends BaseContent {
    type: "user_activity";
    userId: UUID;
    activityType: "deposit" | "vote" | "proposal" | "strategy" | "swap";
    details: Record<string, any>;
    timestamp: number;
}

export interface UserReputationUpdate extends BaseContent {
    type: "reputation_update";
    userId: UUID;
    previousReputation: number;
    newReputation: number;
    reason: string;
    timestamp: number;
}

// Constants for reputation scoring
export const REPUTATION_SCORES = {
    DEPOSIT: 10,
    PROPOSAL_CREATED: 5,
    PROPOSAL_PASSED: 15,
    VOTE_CAST: 2,
    STRATEGY_SUCCESS: 20
} as const; 