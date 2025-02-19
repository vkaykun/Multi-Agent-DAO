import { IAgentRuntime, UUID, elizaLogger } from "@elizaos/core";
import { ProposalContent } from "../types/proposal";
import { findUniversalContent, queryUniversalContent, findContentById } from "./search";
import { ROOM_IDS } from "../constants";

/**
 * Finds a proposal by either its full UUID or short ID.
 * First attempts direct memory lookup, then falls back to room searches.
 */
export async function findProposal(
    runtime: IAgentRuntime,
    proposalId: UUID
): Promise<ProposalContent | null> {
    try {
        // Try direct memory lookup first
        const directMemory = await runtime.messageManager.getMemoryById(proposalId);
        if (directMemory && directMemory.content.type === "proposal") {
            return directMemory.content as ProposalContent;
        }

        // If direct lookup fails, try DAO room
        const proposal = await findContentById<ProposalContent>(
            runtime,
            proposalId,
            "proposal",
            ROOM_IDS.DAO
        );

        if (proposal) {
            return proposal;
        }

        // Last resort: check proposal-specific room
        return findContentById<ProposalContent>(
            runtime,
            proposalId,
            "proposal",
            ROOM_IDS.PROPOSAL
        );
    } catch (error) {
        elizaLogger.error(`Error finding proposal ${proposalId}:`, error);
        return null;
    }
}

/**
 * Query proposals with filtering and sorting options
 */
export async function queryProposals(
    runtime: IAgentRuntime,
    options: {
        filter?: (proposal: ProposalContent) => boolean;
        sort?: (a: ProposalContent, b: ProposalContent) => number;
        limit?: number;
    } = {}
): Promise<ProposalContent[]> {
    try {
        return queryUniversalContent<ProposalContent>(
            runtime,
            "proposal",
            {
                searchGlobalOnly: true,  // Proposals should always be in global room
                ...options
            }
        );
    } catch (error) {
        elizaLogger.error("Error querying proposals:", error);
        return [];
    }
} 