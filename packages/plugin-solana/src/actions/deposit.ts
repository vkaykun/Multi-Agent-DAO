// packages/plugin-solana/src/actions/deposit.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { Connection } from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils.js";
import { validateCommand } from "../utils/commandValidation.js";

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "!deposit",
                action: "deposit",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Send SOL to this address:\n\n`{{walletAddress}}`\n\nAfter sending, you must use !verify <tx_signature> to confirm your deposit immediately.",
                action: "deposit"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@123456789> !deposit",
                action: "deposit",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Send SOL to this address:\n\n`{{walletAddress}}`\n\nAfter sending, you must use !verify <tx_signature> to confirm your deposit immediately.",
                action: "deposit"
            },
        },
    ],
];

export const deposit: Action = {
    name: "deposit",
    description: "Shows the deposit address and instructions for sending SOL",
    examples,
    similes: ["contribute", "send money", "add funds"],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Skip if message is from the assistant
        if (message.userId === runtime.agentId) {
            elizaLogger.debug("Skipping validation for assistant's own message");
            return false;
        }

        const text = message.content.text.trim();

        // Simple validation for !deposit command, allowing mentions
        return validateCommand(text, "deposit");
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State | undefined,
        _options: { [key: string]: unknown } | undefined,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            elizaLogger.debug('[HANDLER] Processing request');

            // Get the wallet public key with better error handling
            elizaLogger.debug('Attempting to get wallet key...');
            const result = await getWalletKey(runtime, false);
            elizaLogger.debug('getWalletKey result:', result);

            if (!result.publicKey) {
                elizaLogger.error("No public key returned from getWalletKey", {
                    result,
                    runtimeSettings: {
                        hasSolanaPublicKey: !!runtime.getSetting("SOLANA_PUBLIC_KEY"),
                        hasWalletPublicKey: !!runtime.getSetting("WALLET_PUBLIC_KEY"),
                        hasEnvSolanaKey: !!process.env.SOLANA_PUBLIC_KEY,
                        hasEnvWalletKey: !!process.env.WALLET_PUBLIC_KEY
                    }
                });
                throw new Error("Could not retrieve wallet public key");
            }
            const walletAddress = result.publicKey.toBase58();
            elizaLogger.debug(`Retrieved wallet address: ${walletAddress}`);

            // Query the current SOL balance
            const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
            elizaLogger.debug(`Using RPC URL: ${rpcUrl}`);

            const connection = new Connection(rpcUrl, {
                commitment: "confirmed",
                confirmTransactionInitialTimeout: 60000,
                wsEndpoint: rpcUrl.replace('https://', 'wss://'),
                disableRetryOnRateLimit: false,
                httpHeaders: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                fetch: (input: string | URL | Request, init?: RequestInit) => {
                    elizaLogger.debug(`RPC Request to: ${input.toString()}`);
                    return fetch(input, init);
                }
            });

            let retries = 3;
            let balance;
            while (retries > 0) {
                try {
                    balance = await connection.getBalance(result.publicKey);
                    break;
                } catch (e) {
                    retries--;
                    if (retries === 0) throw e;
                    elizaLogger.warn(`RPC request failed, retrying... (${retries} attempts left)`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries)));
                }
            }

            const solBalance = (balance ?? 0) / 1e9; // Convert lamports to SOL
            elizaLogger.debug(`Retrieved balance: ${solBalance} SOL`);

            const response = {
                text: `Send SOL to this address:\n\n` +
                      `\`${walletAddress}\`\n\n` +
                      `Current pool: ${solBalance.toFixed(4)} SOL\n\n` +
                      `After sending, you must:\n` +
                      `1. Use \`!verify <tx_signature>\` to confirm your deposit immediately\n` +
                      `2. You can always use \`!balance\` to check your total contribution in the pool\n\n`
            };

            callback?.(response);
            return true;
        } catch (error) {
            const err = error as Error;
            elizaLogger.error("Error processing deposit request:", {
                error: err,
                errorMessage: err.message,
                errorStack: err.stack,
                errorName: err.name,
                errorType: typeof err
            });

            // Provide more specific error messages based on the error type
            let errorMessage = "Sorry, I encountered an error processing your request. Please try again later.";
            if (err.message?.includes("public key")) {
                errorMessage = "Error: Could not access the treasury wallet. Please contact an administrator.";
            } else if (err.message?.includes("429")) {
                errorMessage = "The Solana network is experiencing high traffic. Please try again in a few moments.";
            }

            callback?.({
                text: errorMessage
            });
            return false;
        }
    },
};
