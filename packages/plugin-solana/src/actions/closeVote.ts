// packages/plugin-solana/src/actions/closeVote.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    generateObject,
    ModelClass,
    composeContext,
    generateText,
    stringToUuid,
    IMemoryManager,
} from "@elizaos/core";
import { TextChannel } from "discord.js";
import { ProposalContent } from "../shared/types/proposal";
import {
    ContentStatus,
    ContentStatusIndex,
    getContentStatus,
    isValidStatusTransition
} from "../shared/types/base";
import { findProposal } from "../shared/utils/proposal";
import { ROOM_IDS } from "../shared/constants";

// Template for close vote detection
const closeVoteDetectionTemplate = `You are a DAO assistant. Analyze if the user's message is requesting to close/finalize a proposal:

"{{message.content.text}}"

Consider if the user is:
1. Explicitly requesting to close (e.g., "close proposal...", "finalize proposal...")
2. Suggesting ending the vote (e.g., "end voting on...", "conclude proposal...")
3. Asking to tally/count votes (e.g., "count votes for...", "tally proposal...")

Extract:
1. The proposal ID (usually a 6-character code like 'abc123')
2. The confidence in this interpretation

Return a JSON object:
{
    "isCloseRequest": boolean,
    "proposalId": string | null,
    "confidence": number,
    "reason": string
}

Example responses:
{
    "isCloseRequest": true,
    "proposalId": "abc123",
    "confidence": 0.95,
    "reason": "User explicitly requests to close proposal abc123"
}
{
    "isCloseRequest": true,
    "proposalId": "xyz789",
    "confidence": 0.9,
    "reason": "User wants to finalize and tally votes for proposal xyz789"
}`;

// Add template for agent reasoning about closing votes
const closeVoteReasoningTemplate = `You are Vela, an autonomous AI DAO assistant. A proposal vote has just been closed.

Final Results:
- Proposal ID: {{state.closeData.proposalId}}
- Final Yes Votes: {{state.closeData.yesCount}}
- Final No Votes: {{state.closeData.noCount}}
- Result: {{state.closeData.result}}
- Required:
  • Quorum: {{state.closeData.requirements.quorum}}
  • Minimum Yes Votes: {{state.closeData.requirements.minimumYesVotes}}
  • Minimum Yes Percentage: {{state.closeData.requirements.minimumVotePercentage}}%
- Achieved:
  • Quorum Reached: {{state.closeData.quorumReached}}
  • Yes Vote Percentage: {{state.closeData.yesPercentage}}%

Please provide a natural, first-person response announcing the vote closure. Consider:
1. The significance of the outcome
2. Whether all requirements were met (quorum, minimum votes, percentage)
3. Any notable aspects of the voting pattern
4. Next steps (if any)

Keep your response conversational but professional. Include the final results but make them feel natural.

Example:
"I've closed the voting period for proposal #abc123. With 4 yes votes and 1 no vote, we achieved quorum and the proposal has passed. I appreciate everyone's participation in this decision."`;

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "Let's close proposal #abc123",
                action: "close_vote"
            }
        },
        {
            user: "Vela",
            content: {
                text: "✅ Proposal #abc123 has been closed.\nFinal results:\n👍 Yes: 3\n👎 No: 1\nResult: PASSED",
                action: "close_vote"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "Can we finalize the vote on proposal abc123?",
                action: "close_vote"
            }
        },
        {
            user: "Vela",
            content: {
                text: "✅ Proposal #abc123 has been closed.\nFinal results:\n👍 Yes: 4\n👎 No: 1\nResult: PASSED",
                action: "close_vote"
            }
        }
    ]
];

// Update ProposalContent status type
type ProposalExecutionStatus = "open" | "passed" | "rejected" | "executed" | "pending_execution";

// Add vote requirement interface
interface VoteRequirements {
    quorum: number;
    minimumYesVotes: number;
    minimumVotePercentage: number;
}

function getVoteRequirements(runtime: IAgentRuntime): VoteRequirements {
    // Get requirements from config or environment
    const quorum = parseInt(runtime.getSetting("proposalQuorum") || "3", 10);
    const minimumYesVotes = parseInt(runtime.getSetting("proposalMinimumYesVotes") || "0", 10);
    const minimumVotePercentage = parseInt(runtime.getSetting("proposalMinimumVotePercentage") || "50", 10);

    return {
        quorum,
        minimumYesVotes,
        minimumVotePercentage
    };
}

async function processCloseVote(
    runtime: IAgentRuntime,
    userId: string,
    proposalId: string
): Promise<{ success: boolean; error?: string; yesCount?: number; noCount?: number; result?: string }> {
    const memoryManager = runtime.messageManager as IMemoryManager;
    
    try {
        // Start transaction
        await memoryManager.beginTransaction();

        // Use the new findProposal utility
        const found = await findProposal(runtime, stringToUuid(proposalId));
        if (!found) {
            await memoryManager.rollbackTransaction();
            return { success: false, error: "Proposal not found" };
        }

        const proposal = found as ProposalContent;
        
        // Check if proposal is already closed
        if (proposal.status !== getContentStatus(ContentStatusIndex.OPEN)) {
            await memoryManager.rollbackTransaction();
            return { success: false, error: "This proposal is already closed" };
        }

        // Get vote requirements
        const requirements = getVoteRequirements(runtime);

        // Calculate result
        const yesCount = proposal.yes.length;
        const noCount = proposal.no.length;
        const totalVotes = yesCount + noCount;
        const yesPercentage = totalVotes > 0 ? (yesCount / totalVotes) * 100 : 0;

        let result: string;
        let newStatus: ContentStatus;
        let failureReason: string | null = null;
        
        // Check all voting requirements
        if (totalVotes < requirements.quorum) {
            failureReason = "No Quorum";
        } else if (yesCount < requirements.minimumYesVotes) {
            failureReason = "Insufficient Yes Votes";
        } else if (yesPercentage < requirements.minimumVotePercentage) {
            failureReason = "Insufficient Vote Percentage";
        }

        if (failureReason) {
            result = `FAILED (${failureReason})`;
            newStatus = getContentStatus(ContentStatusIndex.REJECTED);
        } else {
            if (yesCount > noCount) {
                result = "PASSED";
                newStatus = getContentStatus(ContentStatusIndex.PENDING_EXECUTION);
                
                // Validate status transition
                if (!isValidStatusTransition(proposal.status, newStatus)) {
                    await memoryManager.rollbackTransaction();
                    return { success: false, error: `Invalid status transition from ${proposal.status} to ${newStatus}` };
                }
                
                // Create execution memory
                await memoryManager.createMemory({
                    id: stringToUuid(`proposal-passed-${proposal.shortId}-${Date.now()}`),
                    content: {
                        type: "proposal_passed",
                        proposalId: proposal.id,
                        shortId: proposal.shortId,
                        text: `Proposal ${proposal.shortId} passed and ready for execution`,
                        ...proposal,
                        status: newStatus
                    },
                    roomId: ROOM_IDS.PROPOSAL,
                    userId: runtime.agentId,
                    agentId: runtime.agentId
                });
            } else {
                result = "FAILED (More No Votes)";
                newStatus = getContentStatus(ContentStatusIndex.REJECTED);
            }
        }

        // Validate final status transition
        if (!isValidStatusTransition(proposal.status, newStatus)) {
            await memoryManager.rollbackTransaction();
            return { success: false, error: `Invalid status transition from ${proposal.status} to ${newStatus}` };
        }

        // Update proposal status
        proposal.status = newStatus;
        proposal.closedAt = Date.now();
        proposal.result = result;
        proposal.voteStats = {
            total: totalVotes,
            yes: yesCount,
            no: noCount,
            totalVotingPower: totalVotes,
            totalYesPower: yesCount,
            totalNoPower: noCount,
            yesPowerPercentage: (yesCount / totalVotes) * 100,
            quorumReached: totalVotes >= requirements.quorum,
            minimumYesVotesReached: yesCount >= requirements.minimumYesVotes,
            minimumPercentageReached: yesPercentage >= requirements.minimumVotePercentage
        };

        // Update the proposal in memory
        await memoryManager.createMemory({
            id: stringToUuid(`status-${proposal.shortId}-${Date.now()}`),
            content: {
                type: "proposal_status_changed",
                proposalId: proposal.id,
                shortId: proposal.shortId,
                previousStatus: proposal.status,
                status: newStatus,
                text: `Proposal ${proposal.shortId} status changed to ${newStatus}`,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    id: proposal.id,
                    shortId: proposal.shortId,
                    voteStats: proposal.voteStats
                }
            },
            roomId: ROOM_IDS.DAO,
            userId: runtime.agentId,
            agentId: runtime.agentId
        });

        await memoryManager.commitTransaction();

        return {
            success: true,
            yesCount,
            noCount,
            result
        };
    } catch (error) {
        elizaLogger.error("Error processing close vote:", error);
        return { success: false, error: "Failed to process close vote" };
    }
}

const closeVote: Action = {
    name: "close_vote",
    description: "Handles natural language requests to close/finalize proposals",
    examples,
    similes: [
        "close proposal", "finalize vote", "end voting", "conclude proposal",
        "tally votes", "count votes", "finish voting", "complete proposal"
    ],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (message.userId === runtime.agentId || !message.content.text.trim()) {
            return false;
        }

        const context = composeContext({
            state: state || {} as State,
            template: closeVoteDetectionTemplate
        });

        try {
            const rawResponse = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            const response = rawResponse as unknown as {
                isCloseRequest: boolean;
                proposalId: string | null;
                confidence: number;
                reason: string;
            };

            if (response.isCloseRequest && response.proposalId && response.confidence > 0.7) {
                // Store the extracted information for the handler
                (message.content as any).proposalId = response.proposalId;
                return true;
            }

            elizaLogger.debug("Close vote detection result:", response);
        } catch (err) {
            elizaLogger.error("Error in close vote detection:", err);
        }

        return false;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } | undefined,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const proposalId = (message.content as any).proposalId;

            if (!proposalId) {
                callback?.({ text: "I couldn't find a proposal ID in your message. Please specify which proposal you want to close." });
                return false;
            }

            const result = await processCloseVote(
                runtime,
                message.userId,
                proposalId
            );

            if (!result.success) {
                callback?.({ text: `❌ ${result.error}` });
                return false;
            }

            // Generate agent's reasoning about the vote closure
            const closeVoteState = {
                ...state,
                closeData: {
                    proposalId,
                    yesCount: result.yesCount,
                    noCount: result.noCount,
                    result: result.result,
                    requirements: getVoteRequirements(runtime),
                    quorumReached: (result.yesCount + result.noCount) >= 3,
                    yesPercentage: result.yesCount > 0 ? ((result.yesCount / (result.yesCount + result.noCount)) * 100) : 0
                }
            };

            const reasoningContext = composeContext({
                state: closeVoteState,
                template: closeVoteReasoningTemplate
            });

            const agentResponse = await generateText({
                runtime,
                context: reasoningContext,
                modelClass: ModelClass.LARGE
            });

            callback?.({ text: agentResponse });
            return true;

        } catch (error) {
            elizaLogger.error("Error in close vote handler:", error);
            callback?.({ text: "Sorry, I encountered an error closing the vote. Please try again." });
            return false;
        }
    }
};

function hasClosePermission(runtime: IAgentRuntime, userId: string): Promise<boolean> {
    // TODO: Implement proper permission checking
    // For now, allow any user to close votes
    return Promise.resolve(true);
}

function startProposalMonitoring(runtime: IAgentRuntime): NodeJS.Timeout {
    return setInterval(async () => {
        try {
            const proposals = await runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1000,
            });

            const openProposals = proposals.filter(mem => 
                mem.content.type === "proposal" && 
                (mem.content as ProposalContent).status === "open"
            );

            for (const proposalMem of openProposals) {
                const proposal = proposalMem.content as ProposalContent;
                if (proposal.deadline < Date.now()) {
                    await processCloseVote(runtime, runtime.agentId, proposal.shortId);
                    
                    // Create a status change memory
                    await runtime.messageManager.createMemory({
                        id: stringToUuid(`auto-close-${proposal.shortId}-${Date.now()}`),
                        content: {
                            type: "proposal_auto_closed",
                            proposalId: proposal.id,
                            shortId: proposal.shortId,
                            text: `Proposal ${proposal.shortId} was automatically closed due to deadline expiration`,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        },
                        roomId: ROOM_IDS.PROPOSAL,
                        userId: runtime.agentId,
                        agentId: runtime.agentId
                    });
                }
            }
        } catch (error) {
            elizaLogger.error("Error in proposal monitoring:", error);
        }
    }, 60000); // Check every minute
}

// Single export statement for all functions
export {
    closeVote,
    processCloseVote,
    hasClosePermission,
    getVoteRequirements,
    startProposalMonitoring
};