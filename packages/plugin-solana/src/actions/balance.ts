// packages/plugin-solana/src/actions/balance.ts

import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils.js";
import { Client, Message } from "discord.js";
import { validateCommand } from "../utils/commandValidation.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ENDPOINTS } from "../endpoints.js";
import { SwapService } from "../services/swapService";

interface DepositContent extends Content {
    type: "deposit";
    status: "completed" | "pending";
    amountSOL: number;
    timestamp: number;
    txSignature?: string;
    fromAddress?: string;
    discordId: string;
}

interface SwapContent extends Content {
    type: "swap";
    status: "completed";
    inputToken: string;
    outputToken: string;
    inputAmount: number;
    outputAmount: number;
    timestamp: number;
    txSignature: string;
}

interface Contributor {
    userId: string;
    username?: string;
    totalAmount: number;
    lastDeposit: number;
    depositCount: number;
    transactions: Array<{
        txSignature: string;
        amount: number;
        timestamp: number;
    }>;
}

interface TokenPriceInfo {
    price: number;
    symbol?: string;
    error?: string;
    source?: string;
}

interface DexScreenerResponse {
    pairs?: {
        liquidity?: { usd?: number };
        priceUsd?: string;
        baseToken?: { symbol?: string };
    }[];
}

interface HeliusResponse {
    error?: unknown;
    result?: any[];
}

const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "!balance",
                action: "balance",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Pool Status:\nTotal: 100.0000 SOL\nTotal Contributors: 5\nYour Total: 20.0000 SOL (20.00%)",
                action: "balance"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@123456789> !balance",
                action: "balance",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Pool Status:\nTotal: 100.0000 SOL\nTotal Contributors: 5\nYour Total: 20.0000 SOL (20.00%)",
                action: "balance"
            },
        },
    ],
];

const MIN_TOKEN_VALUE_USD = 1;

// Price fetching with multiple sources
async function getTokenPrice(address: string): Promise<TokenPriceInfo> {
    try {
        const response = await fetch(
            `${ENDPOINTS.DEXSCREENER_API}/tokens/${address}`
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json() as DexScreenerResponse;
        if (!data.pairs || data.pairs.length === 0) {
            throw new Error("No price data available");
        }

        // Sort pairs by liquidity to get the most liquid pair
        const sortedPairs = data.pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
        const bestPair = sortedPairs[0];

        if (!bestPair?.priceUsd) {
            throw new Error("No price data in most liquid pair");
        }

        return {
            price: Number(bestPair.priceUsd),
            symbol: bestPair.baseToken?.symbol,
            source: 'dexscreener'
        };
    } catch (error) {
        elizaLogger.error(`Error getting DexScreener price for ${address}:`, error);
        return {
            price: 0,
            error: (error as Error).message,
            source: 'dexscreener'
        };
    }
}

async function getTokenPrices(mintAddresses: string[]): Promise<Map<string, TokenPriceInfo>> {
    const priceMap = new Map<string, TokenPriceInfo>();

    for (const address of mintAddresses) {
        try {
            const priceInfo = await getTokenPrice(address);
            priceMap.set(address, priceInfo);
        } catch (error) {
            elizaLogger.error(`Error getting price for ${address}:`, error);
            priceMap.set(address, {
                price: 0,
                error: (error as Error).message,
                source: 'dexscreener'
            });
        }
    }

    return priceMap;
}

// Add new function to fetch token accounts using Helius
async function getHeliusTokenAccounts(walletAddress: string): Promise<any[]> {
    elizaLogger.debug(`Fetching token accounts from Helius for wallet: ${walletAddress}`);

    try {
        const response = await fetch(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getTokenAccounts',
                params: [
                    walletAddress,
                    {
                        programId: TOKEN_PROGRAM_ID.toString()
                    }
                ]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json() as HeliusResponse;

        if (data.error) {
            throw new Error(`Helius API error: ${JSON.stringify(data.error)}`);
        }

        elizaLogger.debug(`Successfully fetched ${data.result?.length || 0} token accounts from Helius`);
        return data.result || [];
    } catch (error) {
        elizaLogger.error(`Failed to fetch token accounts from Helius: ${(error as Error).message}`);
        return [];
    }
}

export const balance: Action = {
    name: "balance",
    description: "Shows the current pool balance and user contributions",
    examples,
    similes: ["fund status", "pool status", "treasury"],
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Skip if message is from the assistant
        if (message.userId === runtime.agentId) {
            elizaLogger.debug("Skipping validation for assistant's own message");
            return false;
        }

        const text = message.content.text.trim();

        // Simple validation for !balance command, allowing mentions
        return validateCommand(text, "balance");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } | undefined,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const swapService = new SwapService(runtime);
            const { publicKey } = await getWalletKey(runtime, false);
            if (!publicKey) {
                callback?.({ text: "No wallet configured for balance check" });
                return false;
            }

            const connection = new Connection(
                runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
            );

            // Get token balances
            const tokens = await connection.getParsedTokenAccountsByOwner(publicKey, {
                programId: TOKEN_PROGRAM_ID
            });

            let totalValueUsd = 0;
            const balances: Array<{
                token: string;
                amount: string;
                valueUsd: number;
                price: number;
            }> = [];

            // Process each token balance
            for (const { account, pubkey } of tokens.value) {
                const parsedInfo = account.data.parsed.info;
                const tokenAddress = parsedInfo.mint;
                const amount = parsedInfo.tokenAmount.uiAmount;

                if (amount > 0) {
                    const priceInfo = await swapService.getTokenPrice(tokenAddress);
                    if (priceInfo) {
                        const valueUsd = amount * priceInfo.price;
                        totalValueUsd += valueUsd;
                        balances.push({
                            token: tokenAddress,
                            amount: amount.toString(),
                            valueUsd,
                            price: priceInfo.price
                        });
                    }
                }
            }

            // Format response
            const response = formatBalanceResponse(balances, totalValueUsd);
            callback?.({ text: response });
            return true;

        } catch (error) {
            elizaLogger.error("Error checking balance:", error);
            callback?.({ text: "Sorry, I encountered an error checking your balance. Please try again." });
            return false;
        }
    },
};

function formatBalanceResponse(
    balances: Array<{
        token: string;
        amount: string;
        valueUsd: number;
        price: number;
    }>,
    totalValueUsd: number
): string {
    const sortedBalances = balances.sort((a, b) => b.valueUsd - a.valueUsd);
    
    let response = "📊 Current Portfolio:\n\n";
    
    for (const balance of sortedBalances) {
        response += `${balance.token}:\n`;
        response += `• Amount: ${balance.amount}\n`;
        response += `• Price: $${balance.price.toFixed(4)}\n`;
        response += `• Value: $${balance.valueUsd.toFixed(2)}\n\n`;
    }
    
    response += `\nTotal Portfolio Value: $${totalValueUsd.toFixed(2)}`;
    return response;
}