// packages/plugin-solana/src/actions/vote.ts

import {
    Action,
    ActionExample,
    Content,
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
    UUID,
    IMemoryManager,
} from "@elizaos/core";
import { TextChannel, MessageReaction, User } from "discord.js";
import { ProposalContent } from "./propose.js";
import { ROOM_IDS } from "../shared/constants";
import { v4 as uuidv4 } from 'uuid';

// Template for vote detection
const voteDetectionTemplate = `You are a DAO assistant. Analyze if the user's message is casting a vote on a proposal:

"{{message.content.text}}"

Consider if the user is:
1. Explicitly voting (e.g., "I vote yes on...", "voting no to...")
2. Expressing support/opposition (e.g., "I support...", "I'm against...")
3. Using reactions/emojis (e.g., "👍 to proposal...", "thumbs down on...")

Extract:
1. The proposal ID (usually a 6-character code like 'abc123')
2. Whether it's a yes/no vote
3. The confidence in this interpretation

Return a JSON object:
{
    "isVote": boolean,
    "proposalId": string | null,
    "isYesVote": boolean | null,
    "confidence": number,
    "reason": string
}

Example responses:
{
    "isVote": true,
    "proposalId": "abc123",
    "isYesVote": true,
    "confidence": 0.95,
    "reason": "User explicitly votes yes on proposal abc123"
}
{
    "isVote": true,
    "proposalId": "xyz789",
    "isYesVote": false,
    "confidence": 0.9,
    "reason": "User expresses opposition to proposal xyz789"
}`;

// Add template for agent reasoning about votes
const voteReasoningTemplate = `You are Vela, an autonomous AI DAO assistant. A user has just voted on a proposal.

Vote Details:
- Proposal ID: {{state.voteData.proposalId}}
- Vote Type: {{state.voteData.voteType}}
- Current Yes Votes: {{state.voteData.yesCount}}
- Current No Votes: {{state.voteData.noCount}}
- Required for Quorum: 3

Please provide a natural, first-person response acknowledging the vote. Consider:
1. The current vote distribution
2. Progress towards quorum
3. Any notable voting patterns or trends

Keep your response conversational but professional. Include the vote counts but make them feel natural.

Example:
"Thanks for voting! I've recorded your support for proposal #abc123. We now have 3 yes votes and 1 no vote. We've reached quorum, but voting remains open for others to weigh in."`;

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "I vote yes on proposal #abc123",
                action: "vote"
            }
        },
        {
            user: "Vela",
            content: {
                text: "✅ Vote recorded! Proposal #abc123 now has:\n👍 Yes: 3\n👎 No: 1",
                action: "vote"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "I support proposal abc123",
                action: "vote"
            }
        },
        {
            user: "Vela",
            content: {
                text: "✅ Vote recorded! Proposal #abc123 now has:\n👍 Yes: 4\n👎 No: 1",
                action: "vote"
            }
        }
    ]
];

async function processVote(
    runtime: IAgentRuntime,
    userId: string,
    proposalId: string,
    isYesVote: boolean
): Promise<{ success: boolean; error?: string; yesCount?: number; noCount?: number }> {
    const memoryManager = runtime.messageManager as IMemoryManager;
    
    try {
        // Start transaction
        await memoryManager.beginTransaction();

        // Fetch the proposal from global DAO room
        const proposals = await memoryManager.getMemories({
            roomId: ROOM_IDS.DAO,
            count: 1000,
        });

        const proposalMem = proposals.find(mem =>
            mem.content.type === "proposal" &&
            mem.content.shortId === proposalId
        );

        if (!proposalMem) {
            await memoryManager.rollbackTransaction();
            return { success: false, error: "Proposal not found" };
        }

        const proposal = proposalMem.content as ProposalContent;

        // Check if proposal is still open
        if (proposal.status !== "open") {
            await memoryManager.rollbackTransaction();
            return { success: false, error: "This proposal is no longer open for voting" };
        }

        // Check if user has already voted
        const hasVotedYes = proposal.yes.includes(userId);
        const hasVotedNo = proposal.no.includes(userId);

        // Remove any existing votes
        if (hasVotedYes) {
            proposal.yes = proposal.yes.filter(id => id !== userId);
        }
        if (hasVotedNo) {
            proposal.no = proposal.no.filter(id => id !== userId);
        }

        // Add new vote
        if (isYesVote) {
            proposal.yes.push(userId);
        } else {
            proposal.no.push(userId);
        }

        // Update the proposal in global DAO room
        await memoryManager.createMemory({
            ...proposalMem,
            content: proposal,
            roomId: ROOM_IDS.DAO
        });

        // Create vote memory
        await memoryManager.createMemory({
            id: stringToUuid(`vote-${proposalId}-${runtime.agentId}-${Date.now()}`),
            content: {
                type: "vote",
                text: `Vote cast for proposal ${proposalId}`,
                status: "completed",
                agentId: runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    proposalId,
                    voter: userId,
                    support: isYesVote ? 'yes' : 'no',
                    weight: 1,
                    reason: `Vote cast by ${userId} on proposal ${proposalId}`
                }
            },
            roomId: ROOM_IDS.DAO,
            userId: runtime.agentId,
            agentId: runtime.agentId
        });

        // Commit transaction
        await memoryManager.commitTransaction();

        return {
            success: true,
            yesCount: proposal.yes.length,
            noCount: proposal.no.length
        };
    } catch (error) {
        // Rollback on any error
        await memoryManager.rollbackTransaction();
        elizaLogger.error("Error processing vote:", error);
        return { success: false, error: "Failed to process vote" };
    }
}

export const vote: Action = {
    name: "vote",
    description: "Handles natural language voting on proposals",
    examples,
    similes: [
        "cast vote", "support proposal", "oppose proposal", "agree with",
        "disagree with", "approve", "reject", "thumbs up", "thumbs down"
    ],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (message.userId === runtime.agentId || !message.content.text.trim()) {
            return false;
        }

        const context = composeContext({
            state: state || {} as State,
            template: voteDetectionTemplate
        });

        try {
            const rawResponse = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            const response = rawResponse as unknown as {
                isVote: boolean;
                proposalId: string | null;
                isYesVote: boolean | null;
                confidence: number;
                reason: string;
            };

            if (response.isVote && response.proposalId && response.confidence > 0.7) {
                // Store the extracted information for the handler
                (message.content as any).proposalId = response.proposalId;
                (message.content as any).isYesVote = response.isYesVote;
                return true;
            }

            elizaLogger.debug("Vote detection result:", response);
        } catch (err) {
            elizaLogger.error("Error in vote detection:", err);
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
            const isYesVote = (message.content as any).isYesVote;

            if (!proposalId) {
                callback?.({ text: "I couldn't find a proposal ID in your message. Please specify which proposal you're voting on." });
                return false;
            }

            const result = await processVote(
                runtime,
                message.userId,
                proposalId,
                isYesVote
            );

            if (!result.success) {
                callback?.({ text: `❌ ${result.error}` });
                return false;
            }

            // Generate agent's reasoning about the vote
            const voteState = {
                ...state,
                voteData: {
                    proposalId,
                    voteType: isYesVote ? "Support" : "Opposition",
                    yesCount: result.yesCount,
                    noCount: result.noCount
                }
            };

            const reasoningContext = composeContext({
                state: voteState,
                template: voteReasoningTemplate
            });

            const agentResponse = await generateText({
                runtime,
                context: reasoningContext,
                modelClass: ModelClass.LARGE
            });

            callback?.({ text: agentResponse });
            return true;

        } catch (error) {
            elizaLogger.error("Error in vote handler:", error);
            callback?.({ text: "Sorry, I encountered an error processing your vote. Please try again." });
            return false;
        }
    }
};

// Add function to handle emoji reactions
export async function handleReaction(
    runtime: IAgentRuntime,
    reaction: MessageReaction,
    user: User,
    added: boolean
): Promise<void> {
    try {
        // Skip bot reactions
        if (user.bot) return;

        // Only handle 👍 and 👎 reactions
        const emoji = reaction.emoji.name;
        if (!emoji || (emoji !== '👍' && emoji !== '👎')) return;

        // Find proposal by message ID
        const proposals = await runtime.messageManager.getMemories({
            roomId: runtime.agentId,
            count: 1000,
        });

        const proposalMem = proposals.find(mem =>
            mem.content.type === "proposal" &&
            (mem.content as ProposalContent).messageId === reaction.message.id
        );

        if (!proposalMem) return;

        const proposal = proposalMem.content as ProposalContent;

        // Process the vote
        const result = await processVote(
            runtime,
            user.id,
            proposal.shortId,
            emoji === '👍'
        );

        if (!result.success) {
            // Remove the reaction if vote failed
            await reaction.users.remove(user);
            return;
        }

        // If this was a new reaction and there was an opposite reaction, remove it
        if (added) {
            const oppositeEmoji = emoji === '👍' ? '👎' : '👍';
            const oppositeReaction = reaction.message.reactions.cache.find(r => r.emoji.name === oppositeEmoji);
            if (oppositeReaction) {
                await oppositeReaction.users.remove(user);
            }
        }
    } catch (error) {
        elizaLogger.error("Error handling reaction:", error);
    }
}