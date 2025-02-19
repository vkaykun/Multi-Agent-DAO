// packages/plugin-solana/src/actions/propose.ts

import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    stringToUuid,
    generateObject,
    ModelClass,
    composeContext,
    generateText,
} from "@elizaos/core";
import { Message, TextChannel } from "discord.js";
import { validateActionCommand } from "../utils/governanceUtils.js";
import { StrategyType, StrategyCondition } from "../shared/types/strategy";
import { generateShortId, shortIdToUuid } from "../shared/types/proposal";
import { ROOM_IDS } from "../shared/constants";
import { IMemoryManager } from "@elizaos/core";

// Add interface for proposal interpretation
interface ProposalInterpretation {
    title: string;
    description: string;
    type: "swap" | "strategy" | "governance" | "other";
    details?: {
        inputToken?: string;
        outputToken?: string;
        amount?: number;
        targetPrice?: number;
        stopLoss?: number;
        takeProfit?: number;
    };
}

// Add interface for proposal state
interface ProposalState extends State {
    message?: {
        content: {
            text: string;
        };
    };
}

// Add template for LLM interpretation
const proposalInterpretTemplate = `You are a DAO proposal interpreter. Analyze the following proposal command and provide a natural interpretation.

Original Command: {{message.content.text}}

Format the response as a JSON object with:
- A clear, concise title
- A detailed description in natural language
- The proposal type (swap/strategy/governance/other)
- Any relevant numerical details (amounts, prices, etc.)

Example for a swap:
{
    "title": "Swap 3 SOL for USDC",
    "description": "Proposal to exchange 3 SOL tokens for USDC from the DAO treasury. This swap will be executed through Jupiter aggregator for the best possible price.",
    "type": "swap",
    "details": {
        "inputToken": "SOL",
        "outputToken": "USDC",
        "amount": 3
    }
}

Example for a strategy:
{
    "title": "Set Take Profit Strategy for JUP Position",
    "description": "Implement a take profit strategy for our JUP token position with multiple exit levels to secure profits while maintaining upside potential.",
    "type": "strategy",
    "details": {
        "takeProfit": 20,
        "stopLoss": 10
    }
}

Analyze and interpret this proposal:`;

// Add template for agent reasoning about proposals
const proposalReasoningTemplate = `You are Vela, an autonomous AI DAO assistant. You've just created a new proposal based on a user's request.

Proposal Details:
Title: {{state.proposalData.title}}
Description: {{state.proposalData.description}}
Type: {{state.proposalData.type}}
Current Status: Open for voting
Required Votes: 3

Please provide a natural, first-person response announcing the proposal. Consider:
1. Why this proposal might be important for the DAO
2. Your thoughts on the timing or relevance
3. Any specific aspects voters should consider

Keep your response conversational but professional. Include the key details (proposal ID #{{state.proposalData.shortId}}, voting instructions) but make them feel natural.

Example:
"I've created proposal #abc123 to swap 20 SOL for USDC. Given our current market conditions, I think it's prudent to increase our stablecoin reserves. The proposal is now open for voting - you can support it with !vote abc123 yes or oppose with !vote abc123 no. We'll need at least 3 votes to reach quorum."`;

export interface ProposalContent extends Content {
    type: "proposal";
    id: string;
    shortId: string;
    title: string;
    description: string;
    text: string;
    agentId: string;
    status: "open" | "passed" | "rejected" | "executed";
    yes: string[];
    no: string[];
    deadline: number;
    createdAt: number;
    updatedAt: number;
}

// Add more examples to show natural language support
const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "@Vela I propose we swap 20 SOL for USDC to increase our stablecoin reserves",
                action: "propose"
            }
        },
        {
            user: "Vela",
            content: {
                text: "📢 **New Proposal Created** #123456\n\n**Title**: Swap 20 SOL for USDC\n\n**Description**: Proposal to exchange 20 SOL for USDC to increase the DAO's stablecoin reserves. This will help maintain treasury stability...",
                action: "propose"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "hey vela, can we set a take profit strategy for our JUP position? maybe 20% with a 10% stop loss",
                action: "propose"
            }
        },
        {
            user: "Vela",
            content: {
                text: "📢 **New Proposal Created** #123457\n\n**Title**: JUP Position Risk Management Strategy\n\n**Description**: Implement a strategic exit plan for our JUP position with a 20% take profit target and 10% stop loss protection...",
                action: "propose"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "let's propose a swap of our SOL to that new token at address EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                action: "propose"
            }
        },
        {
            user: "Vela",
            content: {
                text: "📢 **New Proposal Created** #123458\n\n**Title**: Token Swap Proposal\n\n**Description**: Proposal to swap SOL for the specified token (USDC) using Jupiter for optimal execution...",
                action: "propose"
            }
        }
    ]
];

// Add natural language trigger patterns
const PROPOSAL_TRIGGERS = [
    /^(?:hey\s+)?@?vela\s+(?:can|could|should)\s+we/i,
    /^(?:hey\s+)?@?vela\s+(?:i\s+)?(?:want\s+to\s+)?propose/i,
    /^(?:hey\s+)?@?vela\s+let'?s?\s+propose/i,
    /^propose\s+(?:to|that|we|a)?/i,
    /^suggestion:/i,
    /^i\s+suggest\s+(?:that|we)?/i,
    /^let'?s?\s+(?:make\s+a\s+)?proposal/i,
    /^what\s+(?:do\s+you\s+)?think\s+about/i,
    /^how\s+about\s+(?:we|if)/i,
    /^maybe\s+we\s+should/i
];

// Update the proposal detection template to be more comprehensive
const proposalDetectionTemplate = `You are a DAO assistant. Analyze if the user's message is creating a new proposal:

"{{message.content.text}}"

Consider if the user is:
1. Explicitly proposing an action (e.g., "I propose we...", "let's swap...")
2. Suggesting a change (e.g., "we should...", "maybe we could...")
3. Requesting an action that requires voting (e.g., "can we swap...", "should we set...")

Return a JSON object:
{
    "isProposal": boolean,
    "confidence": number,
    "proposalType": "swap" | "strategy" | "governance" | "other",
    "extractedText": string,
    "reason": string
}

Example responses:
{
    "isProposal": true,
    "confidence": 0.95,
    "proposalType": "swap",
    "extractedText": "swap 20 SOL for USDC",
    "reason": "User is explicitly proposing a token swap"
}
{
    "isProposal": true,
    "confidence": 0.85,
    "proposalType": "strategy",
    "extractedText": "set take profit at 20% for our JUP position",
    "reason": "User is suggesting a trading strategy change"
}
{
    "isProposal": false,
    "confidence": 0.9,
    "proposalType": null,
    "extractedText": "",
    "reason": "User is asking for information, not proposing an action"
}`;

export const propose: Action = {
    name: "propose",
    description: "Creates a new governance proposal",
    examples,
    similes: [
        "suggest proposal", "create proposal", "make proposal", 
        "propose action", "new proposal", "suggest idea"
    ],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Skip if message is from the assistant
        if (message.userId === runtime.agentId || !message.content.text.trim()) {
            return false;
        }

        const text = message.content.text.trim();

        // Use LLM to detect if this is a proposal
        const context = composeContext({
            state: state || {} as State,
            template: proposalDetectionTemplate
        });

        try {
            const rawResponse = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            const response = rawResponse as unknown as {
                isProposal: boolean;
                confidence: number;
                proposalType: string;
                extractedText: string;
                reason: string;
            };

            if (response.isProposal && response.confidence > 0.7) {
                // Store the extracted information for the handler
                (message.content as any).proposalType = response.proposalType;
                (message.content as any).extractedText = response.extractedText;
                return true;
            }

            elizaLogger.debug("Proposal detection result:", response);
        } catch (err) {
            elizaLogger.error("Error in proposal detection:", err);
        }

        return false;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
        const memoryManager = runtime.messageManager as IMemoryManager;
        
        try {
            // Start transaction
            await memoryManager.beginTransaction();

            // Generate short ID first
            const shortId = generateShortId();
            // Create proposal ID from short ID
            const proposalId = shortIdToUuid(shortId);

            // Use LLM to interpret proposal details
            const interpretation = await interpretProposal(message.content.text, runtime);
            if (!interpretation) {
                await memoryManager.rollbackTransaction();
                throw new Error("Failed to interpret proposal");
            }

            // Create the proposal content
            const proposal: ProposalContent = {
                type: "proposal",
                id: proposalId,
                shortId,
                title: interpretation.title,
                description: interpretation.description,
                text: message.content.text,
                agentId: runtime.agentId,
                status: "open",
                yes: [],
                no: [],
                deadline: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days from now
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            // If this is a strategy proposal, create strategy memory first
            if (interpretation.type === "strategy") {
                const strategyId = stringToUuid(`strategy-${proposalId}`);
                const strategyContent = {
                    type: "strategy",
                    id: strategyId,
                    strategyType: mapProposalToStrategyType(interpretation),
                    token: interpretation.details?.inputToken || "",
                    baseToken: interpretation.details?.outputToken || "",
                    conditions: extractStrategyConditions(interpretation),
                    status: "draft",
                    sourceProposalId: proposalId,
                    proposalStatus: proposal.status,
                    text: `Strategy created from proposal ${shortId}`,
                    agentId: runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };

                // Create strategy memory
                await memoryManager.createMemory({
                    id: stringToUuid(`mem-${strategyId}`),
                    content: strategyContent,
                    roomId: ROOM_IDS.STRATEGY,
                    userId: runtime.agentId,
                    agentId: runtime.agentId
                });

                // Link strategy to proposal
                proposal.linkedStrategyId = strategyId;
                proposal.strategyStatus = "draft";
            }

            // Create proposal memory in global DAO room
            await memoryManager.createMemory({
                id: stringToUuid(`mem-${proposalId}`),
                content: proposal,
                roomId: ROOM_IDS.DAO,
                userId: runtime.agentId,
                agentId: runtime.agentId
            });

            // Create initial status memory in proposal room
            await memoryManager.createMemory({
                id: stringToUuid(`status-${proposalId}`),
                content: {
                    type: "proposal_status_changed",
                    proposalId,
                    status: proposal.status,
                    previousStatus: null,
                    text: `Proposal ${shortId} created and opened for voting`,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                roomId: ROOM_IDS.PROPOSAL,
                userId: runtime.agentId,
                agentId: runtime.agentId
            });

            // Commit transaction
            await memoryManager.commitTransaction();

            // Return success message
            const response = `📢 **New Proposal Created** #${shortId}\n\n` +
                `**Title**: ${interpretation.title}\n\n` +
                `**Description**: ${interpretation.description}\n\n` +
                `**Type**: ${interpretation.type}\n` +
                `**Status**: Open for voting\n` +
                `**Required Votes**: ${proposal.requiredVotes}\n\n` +
                `Use !vote ${shortId} yes/no to vote on this proposal.`;

            elizaLogger.info(`Created proposal ${shortId}`);
            return true;

        } catch (error) {
            // Rollback on any error
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Error in propose handler:", error);
            throw error;
        }
    }
};

// Helper functions
async function interpretProposal(text: string, runtime: IAgentRuntime): Promise<ProposalInterpretation> {
    const context = composeContext({
        state: {
            bio: "",
            lore: "",
            messageDirections: "",
            postDirections: "",
            roomId: runtime.agentId,
            actors: "",
            recentMessages: "",
            recentMessagesData: [],
            message: { content: { text } }
        },
        template: proposalInterpretTemplate
    });

    const rawInterpretation = await generateObject({
        runtime,
        context,
        modelClass: ModelClass.SMALL
    });

    if (isValidProposalInterpretation(rawInterpretation)) {
        return rawInterpretation;
    }

    throw new Error("Invalid proposal interpretation");
}

function isValidProposalInterpretation(obj: unknown): obj is ProposalInterpretation {
    if (typeof obj !== 'object' || obj === null) return false;
    
    const interpretation = obj as Partial<ProposalInterpretation>;
    
    return (
        typeof interpretation.title === 'string' &&
        typeof interpretation.description === 'string' &&
        (interpretation.type === 'swap' ||
         interpretation.type === 'strategy' ||
         interpretation.type === 'governance' ||
         interpretation.type === 'other')
    );
}

function mapProposalToStrategyType(interpretation: ProposalInterpretation): StrategyType {
    if (interpretation.details?.takeProfit) return "TAKE_PROFIT";
    if (interpretation.details?.stopLoss) return "STOP_LOSS";
    return "GRID"; // Default strategy type
}

function extractStrategyConditions(interpretation: ProposalInterpretation): StrategyCondition[] {
    const conditions: StrategyCondition[] = [];
    
    if (interpretation.details?.takeProfit) {
        conditions.push({
            type: "PRICE",
            operator: ">=",
            value: interpretation.details.takeProfit.toString()
        });
    }

    if (interpretation.details?.stopLoss) {
        conditions.push({
            type: "PRICE",
            operator: "<=",
            value: interpretation.details.stopLoss.toString()
        });
    }

    return conditions;
}