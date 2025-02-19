import {
    Action,
    Memory,
    IAgentRuntime,
    HandlerCallback,
    State,
    elizaLogger,
    generateObject,
    ModelClass,
    composeContext
} from "@elizaos/core";
import { TextChannel } from "discord.js";
import { ProposalContent, ProposalInterpretation, SwapDetails, StrategyDetails } from "../shared/types/proposal";

// Add more comprehensive prompt for better understanding
const checkProposalPrompt = `You are a DAO assistant. The user is asking about a proposal's status or details. Analyze the user's message:

"{{message.content.text}}"

Consider if the user is:
1. Asking about a specific proposal's status (with ID)
2. Requesting proposal details
3. Asking about voting results
4. Checking deadline/timeline

Respond with a JSON object:
{
    "isStatusRequest": boolean,
    "proposalId": string | null,
    "requestType": "status" | "details" | "votes" | "deadline" | null,
    "confidence": number
}

Example responses:
{
    "isStatusRequest": true,
    "proposalId": "abc123",
    "requestType": "status",
    "confidence": 0.95
}
{
    "isStatusRequest": true,
    "proposalId": "xyz789",
    "requestType": "votes",
    "confidence": 0.9
}`;

function formatTimeLeft(deadline: number): string {
    const now = Date.now();
    const timeLeft = deadline - now;
    
    if (timeLeft < 0) {
        return "Expired";
    }
    
    const hours = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
    
    return `${hours}h ${minutes}m remaining`;
}

function getQuorumStatus(proposal: ProposalContent): string {
    const totalVotes = proposal.yes.length + proposal.no.length;
    const requiredVotes = 3; // Could be made configurable
    
    if (totalVotes >= requiredVotes) {
        return "✅ Quorum reached";
    }
    return `⏳ Need ${requiredVotes - totalVotes} more vote${requiredVotes - totalVotes === 1 ? '' : 's'} for quorum`;
}

function getVoteProgress(yesCount: number, noCount: number): string {
    const total = yesCount + noCount;
    if (total === 0) return "No votes yet";
    
    const yesPercent = Math.round((yesCount / total) * 100);
    const noPercent = 100 - yesPercent;
    
    return `[${yesCount}/${total}] ${'▓'.repeat(yesPercent/10)}${'░'.repeat(noPercent/10)} ${yesPercent}%`;
}

// Add examples for the action
const examples = [
    [
        {
            user: "user",
            content: {
                text: "hey vela, what's the status of proposal #abc123?",
                action: "check_proposal_status"
            }
        },
        {
            user: "Vela",
            content: {
                text: "📊 **Proposal #abc123**\n\nStatus: OPEN\nVotes: 👍 2 | 👎 1\nTime: 12h remaining",
                action: "check_proposal_status"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "can you show me the details for proposal abc123?",
                action: "check_proposal_status"
            }
        },
        {
            user: "Vela",
            content: {
                text: "📊 **Proposal #abc123**\n\nTitle: Swap 20 SOL for USDC\nDescription: Proposal to exchange SOL for USDC...",
                action: "check_proposal_status"
            }
        }
    ]
];

export const checkProposalStatus: Action = {
    name: "check_proposal_status",
    description: "Handles natural-language requests to check a proposal's status",
    examples,
    similes: [
        "proposal status", "query status", "how is proposal", "status check",
        "check votes", "proposal progress", "vote count", "proposal details"
    ],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (message.userId === runtime.agentId || !message.content.text.trim()) {
            return false;
        }

        const context = composeContext({
            state: state || {} as State,
            template: checkProposalPrompt
        });

        try {
            const rawResponse = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            const response = rawResponse as unknown as {
                isStatusRequest: boolean;
                proposalId: string | null;
                requestType: string;
                confidence: number;
            };

            if (response.isStatusRequest && response.proposalId && response.confidence > 0.7) {
                (message.content as any).proposalId = response.proposalId;
                (message.content as any).requestType = response.requestType;
                return true;
            }
        } catch (err) {
            elizaLogger.warn("Failed to parse proposal status request:", err);
        }

        return false;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const shortId = (message.content as any).proposalId;
            const requestType = (message.content as any).requestType || "status";

            if (!shortId) {
                callback?.({ text: "I couldn't find a proposal ID in your request. Please include the proposal ID (e.g., 'what's the status of proposal #abc123?')" });
                return false;
            }

            // Fetch the proposal
            const proposals = await runtime.messageManager.getMemories({
                roomId: runtime.agentId,
                count: 1000,
            });

            const proposalMem = proposals.find(mem =>
                mem.content.type === "proposal" &&
                mem.content.shortId === shortId
            );

            if (!proposalMem) {
                callback?.({ text: `❌ Proposal #${shortId} not found. Please check the ID and try again.` });
                return false;
            }

            const proposal = proposalMem.content as ProposalContent & { interpretation: ProposalInterpretation };
            const yesCount = proposal.yes.length;
            const noCount = proposal.no.length;

            // Create detailed status message
            let statusMsg = `📊 **Proposal #${shortId}**\n\n`;
            
            // Add title and description
            statusMsg += `**Title**: ${proposal.interpretation.title}\n\n`;
            
            if (requestType === "details") {
                statusMsg += `**Description**:\n${proposal.interpretation.details.description}\n\n`;
            }

            // Add status section
            statusMsg += `**Current Status**: ${proposal.status.toUpperCase()}\n`;
            statusMsg += `**Time**: ${formatTimeLeft(proposal.deadline)}\n`;
            statusMsg += `**Quorum**: ${getQuorumStatus(proposal)}\n\n`;

            // Add vote section
            statusMsg += `**Votes**:\n`;
            statusMsg += `👍 Yes: ${yesCount}\n`;
            statusMsg += `👎 No: ${noCount}\n`;
            statusMsg += `Progress: ${getVoteProgress(yesCount, noCount)}\n\n`;

            // Add type-specific details if available
            if (proposal.interpretation.details) {
                if (proposal.interpretation.type === 'swap') {
                    const swapDetails = proposal.interpretation.details as SwapDetails;
                    statusMsg += `**Swap Details**:\n`;
                    statusMsg += `• Input: ${swapDetails.amount} ${swapDetails.inputToken}\n`;
                    statusMsg += `• Output: ${swapDetails.outputToken}\n\n`;
                } else if (proposal.interpretation.type === 'strategy') {
                    const strategyDetails = proposal.interpretation.details as StrategyDetails;
                    statusMsg += `**Strategy Details**:\n`;
                    statusMsg += `• Token: ${strategyDetails.token}\n`;
                    statusMsg += `• Amount: ${strategyDetails.amount}\n`;
                    statusMsg += `• Conditions: ${strategyDetails.conditions.map(c => 
                        `${c.type} ${c.operator} ${c.value}`).join(', ')}\n\n`;
                }
            }

            // Add voting instructions if still open
            if (proposal.status === "open") {
                statusMsg += `**How to Vote**:\n`;
                statusMsg += `Use \`!vote ${shortId} yes\` or \`!vote ${shortId} no\`\n`;
            }

            callback?.({ text: statusMsg });
            return true;

        } catch (error) {
            elizaLogger.error("Error in checkProposalStatus handler:", error);
            callback?.({ text: "Sorry, I encountered an error checking the proposal status. Please try again." });
            return false;
        }
    }
}; 