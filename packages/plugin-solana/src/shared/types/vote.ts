import { UUID } from "@elizaos/core";
import { BaseContent, ContentStatus, MemoryMetadata } from "./base";

export interface Vote {
    userId: UUID;
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
    quorumReached: boolean;
    minimumYesVotesReached: boolean;
    minimumPercentageReached: boolean;
}

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

export interface VoteContent extends BaseContent {
    type: "vote";
    agentId: UUID;
    metadata: {
        proposalId: string;
        vote: "yes" | "no";
        votingPower: number;
        reason?: string;
        timestamp: number;
    };
}

export interface ProposalContent extends BaseContent {
    type: "proposal";
    title: string;
    description: string;
    proposer: UUID;
    yes: Vote[];
    no: Vote[];
    voteStats: VoteStats;
    status: "draft" | "open" | "pending_execution" | "executing" | "executed" | "rejected" | "cancelled" | "failed";
    createdAt: number;
    updatedAt: number;
    votingConfig?: {
        quorumThreshold: number;
        minimumYesVotes: number;
        minimumVotePercentage: number;
        votingPeriod: number;
        allowDelegation?: boolean;
        restrictedToRoles?: string[];
    };
} 