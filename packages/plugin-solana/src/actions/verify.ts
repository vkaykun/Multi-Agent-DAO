// packages/plugin-solana/src/actions/verify.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { validateCommandWithParam } from "../utils/commandValidation.js";
import { verifyAndRecordDeposit } from "../utils/depositUtils.js";

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "!verify 3T1iZDEQJvfx9DEubrDXmS676tRdLFEk4t8tzeQfkekCCPbUFAovfve6gAWonN9s87JJHovc37p5qemiKcpt5RyC",
                action: "verify",
            },
        },
        {
            user: "Vela",
            content: {
                text: "✅ Deposit verified! 1.5 SOL received.",
                action: "verify"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@123456789> !verify 3T1iZDEQJvfx9DEubrDXmS676tRdLFEk4t8tzeQfkekCCPbUFAovfve6gAWonN9s87JJHovc37p5qemiKcpt5RyC",
                action: "verify",
            },
        },
        {
            user: "Vela",
            content: {
                text: "✅ Deposit verified! 1.5 SOL received.",
                action: "verify"
            },
        },
    ],
];

export const verify: Action = {
    name: "verify",
    description: "Verifies a deposit transaction",
    examples,
    similes: ["check deposit", "confirm transaction", "validate transfer"],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Skip if message is from the assistant
        if (message.userId === runtime.agentId) {
            elizaLogger.debug("Skipping validation for assistant's own message");
            return false;
        }

        const text = message.content.text.trim();

        // Validate command format with transaction signature parameter
        // Solana transaction signatures are base58 encoded and 88 characters long
        const match = validateCommandWithParam(text, "verify", "[1-9A-HJ-NP-Za-km-z]{88}");

        if (!match) {
            elizaLogger.debug("Verify command validation failed - invalid format");
            return false;
        }

        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State | undefined,
        _options: { [key: string]: unknown } | undefined,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            elizaLogger.debug('[HANDLER] Processing verify request');

            // Extract transaction signature
            const match = validateCommandWithParam(message.content.text.trim(), "verify", "[1-9A-HJ-NP-Za-km-z]{88}");
            if (!match) {
                callback?.({
                    text: "Please provide a valid Solana transaction signature using the format: !verify <signature>"
                });
                return false;
            }

            const txSignature = match[1];

            // Verify and record the deposit
            const deposit = await verifyAndRecordDeposit(txSignature, runtime);

            if (deposit) {
                // Format success message
                const response = {
                    text: `✅ Deposit verified!\n` +
                          `Amount: ${deposit.amountSOL} SOL\n` +
                          `From: \`${deposit.fromAddress}\`\n` +
                          `Transaction: https://explorer.solana.com/tx/${txSignature}`
                };

                callback?.(response);
                return true;
            } else {
                callback?.({
                    text: "❌ Could not verify deposit. Please check that:\n" +
                         "1. The transaction signature is correct\n" +
                         "2. The transaction was successful\n" +
                         "3. Your wallet is registered with !register\n" +
                         "4. The deposit was sent to the correct address"
                });
                return false;
            }
        } catch (error) {
            elizaLogger.error("Error processing verify request:", error);
            callback?.({
                text: "Sorry, I encountered an error verifying your deposit. Please try again later."
            });
            return false;
        }
    },
};