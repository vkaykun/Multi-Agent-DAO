// packages/plugin-solana/src/actions/cancelStrategy.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    stringToUuid,
    UUID
} from "@elizaos/core";
import { validateCommand } from "../utils/commandValidation";
import { createStrategyMemoryContent } from "../shared/types/memory";
import { StrategyContent } from "../shared/types/strategy";
import { BaseContent, ContentStatus } from "../shared/types/base";
import { ActionDefinition } from "../shared/actions/registry";

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "!cancel strategy for SOL",
                action: "cancel_strategy"
            }
        },
        {
            user: "Kron",
            content: {
                text: "✅ Cancelled active strategy for SOL. Position will no longer be monitored.",
                action: "cancel_strategy"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "cancel my JUP strategy",
                action: "cancel_strategy"
            }
        },
        {
            user: "Kron",
            content: {
                text: "✅ Cancelled active strategy for JUP. Position will no longer be monitored.",
                action: "cancel_strategy"
            }
        }
    ],
    [
        {
            user: "user",
            content: {
                text: "cancel strategy abc123",
                action: "cancel_strategy"
            }
        },
        {
            user: "Kron",
            content: {
                text: "✅ Cancelled strategy #abc123. Position will no longer be monitored.",
                action: "cancel_strategy"
            }
        }
    ]
];

const cancelStrategyAction: ActionDefinition<StrategyContent> = {
    type: "cancel_strategy",
    category: "STRATEGY",
    allowedStatuses: ["open", "pending_execution"],
    handler: async (content: StrategyContent, runtime: IAgentRuntime) => {
        try {
            // Get the strategy
            const strategyId = content.metadata?.strategyId;
            if (!strategyId) {
                return false;
            }

            const strategy = await runtime.messageManager.getMemoryById(strategyId as UUID);
            if (!strategy) {
                return false;
            }

            // Create cancellation memory
            await runtime.messageManager.createMemory({
                id: stringToUuid(`cancel-${strategy.id}`),
                content: createStrategyMemoryContent(
                    "strategy_cancellation",
                    `Strategy cancelled by user request`,
                    "cancelled",
                    strategy.id,
                    {
                        reason: content.metadata?.reason || "User cancelled",
                        tags: ["cancellation"],
                        priority: "high"
                    }
                ),
                roomId: runtime.agentId,
                userId: content.agentId,
                agentId: runtime.agentId
            });

            return true;
        } catch (error) {
            return false;
        }
    },
    validate: async (content: StrategyContent, runtime: IAgentRuntime) => {
        if (!content.metadata?.strategyId) {
            return false;
        }

        // Check if strategy exists and can be cancelled
        const strategy = await runtime.messageManager.getMemoryById(content.metadata.strategyId as UUID);
        if (!strategy) {
            return false;
        }

        const status = strategy.content.status;
        return status === "open" || status === "pending_execution";
    },
    sideEffects: ["strategy_status", "treasury_balance"],
    metadata: {
        name: "cancel_strategy",
        description: "Cancel an active trading strategy",
        examples: [
            "Cancel strategy abc123",
            "Stop the trading strategy for SOL"
        ],
        similes: [
            "stop strategy",
            "end strategy",
            "remove strategy"
        ]
    }
};

export default cancelStrategyAction;
