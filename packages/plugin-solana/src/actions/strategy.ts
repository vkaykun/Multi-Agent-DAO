// packages/plugin-solana/src/actions/strategy.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { PositionTracker } from "../providers/positionTracker.js";
import { parseNaturalLanguageStrategy, formatStrategyDetails } from "../utils/strategyParser.js";
import { StrategyExecutor } from "../services/strategyExecutor.js";
import { SwapService } from "../services/swapService.js";

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "set tp at 20% and 50%, sl at 10%",
                action: "strategy"
            }
        },
        {
            user: "Vela",
            content: {
                text: "Strategy configured ✅\nTake Profit 1: 20% (sell 50%)\nTake Profit 2: 50% (sell 50%)\nStop Loss: 10%\nI'll monitor and execute automatically.",
                action: "strategy"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "exit when 200 EMA crosses below",
                action: "strategy"
            }
        },
        {
            user: "Vela",
            content: {
                text: "Strategy configured ✅\nTechnical Exit: 200 EMA crosses below\nI'll monitor and execute automatically.",
                action: "strategy"
            }
        }
    ]
];

export const strategy: Action = {
    name: "strategy",
    description: "Set exit strategy for current position",
    examples,
    similes: ["set take profit", "set stop loss", "exit strategy", "tp/sl"],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        try {
            // Check if user has a recent position
            const positionTracker = new PositionTracker(runtime);
            const position = await positionTracker.getLatestPosition(message.userId);

            if (!position) {
                elizaLogger.debug("No recent position found for strategy setup");
                return false;
            }

            // Try parsing the strategy
            const strategy = await parseNaturalLanguageStrategy(message.content.text, position.entryPrice);
            if (!strategy) {
                elizaLogger.debug("Could not parse strategy from message:", message.content.text);
                return false;
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error validating strategy:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | undefined,
        _options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Get the user's latest position
            const positionTracker = new PositionTracker(runtime);
            const position = await positionTracker.getLatestPosition(message.userId);

            if (!position) {
                callback?.({
                    text: "No active position found. Please execute a swap first before setting up a strategy."
                });
                return false;
            }

            // Get current price for reference
            const currentPrice = await positionTracker.getCurrentPrice(position.token);

            // Parse strategy from natural language with entry price
            const strategy = await parseNaturalLanguageStrategy(message.content.text, position.entryPrice);
            if (!strategy) {
                callback?.({
                    text: "I couldn't understand the strategy. Please use formats like:\n" +
                         "• \"set tp at 20% and 50%, sl at 10%\"\n" +
                         "• \"exit when 200 EMA crosses below\""
                });
                return false;
            }

            // Attach strategy to position
            await positionTracker.attachStrategy(position, strategy);

            // Start strategy monitoring
            const swapService = new SwapService(runtime);
            const strategyExecutor = new StrategyExecutor(runtime, positionTracker, swapService);
            await strategyExecutor.startStrategyMonitoring(message.userId);

            callback?.({
                text: `Strategy set for your ${position.token} position:\n` +
                      `Entry Price: $${position.entryPrice.toFixed(4)}\n` +
                      `Current Price: $${currentPrice.toFixed(4)}\n` +
                      formatStrategyDetails(strategy) +
                      `\n\nI'll monitor the position and execute automatically when conditions are met.`
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error handling strategy setup:", error);
            callback?.({
                text: "Sorry, I encountered an error setting up the strategy. Please try again."
            });
            return false;
        }
    }
};
