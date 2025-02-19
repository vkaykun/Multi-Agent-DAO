// packages/plugin-solana/src/services/swapService.ts

import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils.js";
import { ENDPOINTS } from "../endpoints.js";
import { getOptimalSwapRoute, executeSwapWithRoute, checkPoolReserves, getQuoteForRoute } from "../actions/swap.js";
import { Memory, UUID, stringToUuid } from "@elizaos/core";
import { PriceProvider, TokenPrice } from "../providers/priceProvider";
import { ROOM_IDS } from '../shared/constants';
import { BaseContent } from '../shared/types/base';

interface TokenPriceInfo {
    price: number;
    symbol?: string;
    error?: string;
    source?: string;
    timestamp: number;
}

interface TokenPriceCache {
    [tokenAddress: string]: TokenPriceInfo;
}

interface DexScreenerResponse {
    pairs?: Array<{
        liquidity?: { usd?: number };
        priceUsd?: string;
        baseToken?: { symbol?: string };
    }>;
}

export class SwapService {
    private runtime: IAgentRuntime;
    private connection: Connection;
    private priceCache: TokenPriceCache = {};
    private readonly CACHE_DURATION = 30000; // 30 seconds cache duration
    private priceProvider: PriceProvider;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        this.priceProvider = new PriceProvider(runtime);
    }

    private isCacheValid(tokenAddress: string): boolean {
        const cached = this.priceCache[tokenAddress];
        if (!cached) return false;
        return Date.now() - cached.timestamp < this.CACHE_DURATION;
    }

    public async getTokenPrice(tokenAddress: string): Promise<TokenPrice | null> {
        return this.priceProvider.getTokenPrice(tokenAddress);
    }

    private async executeAtomicOperation<T>(operation: () => Promise<T>): Promise<T> {
        const memoryManager = this.runtime.messageManager;
        await memoryManager.beginTransaction();
        try {
            const result = await operation();
            await memoryManager.commitTransaction();
            return result;
        } catch (error) {
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Error in atomic operation:", {
                error,
                service: 'SwapService'
            });
            throw error;
        }
    }

    async executeSwap(
        fromToken: string,
        toToken: string,
        amount: number,
        userId: string
    ): Promise<UUID> {
        const memoryManager = this.runtime.messageManager;
        
        return await this.executeAtomicOperation(async () => {
            // Create swap request memory
            const swapId = stringToUuid(`swap-${Date.now()}`);
            await memoryManager.createMemory({
                id: swapId,
                content: {
                    id: swapId,
                    type: "swap_request",
                    text: `Swap request: ${amount} ${fromToken} to ${toToken}`,
                    fromToken,
                    toToken,
                    amount,
                    userId,
                    status: "pending_execution",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    agentId: this.runtime.agentId
                } as BaseContent,
                roomId: ROOM_IDS.TREASURY,
                userId: userId as UUID,
                agentId: this.runtime.agentId
            });

            // Get wallet credentials
            const { publicKey, keypair } = await getWalletKey(this.runtime);
            if (!publicKey || !keypair) {
                throw new Error("Failed to get wallet credentials");
            }

            // Get token prices from cache or fetch new ones
            const [fromTokenPrice, toTokenPrice] = await Promise.all([
                this.getTokenPrice(fromToken),
                this.getTokenPrice(toToken)
            ]);

            if (!fromTokenPrice?.price || !toTokenPrice?.price) {
                throw new Error(`Failed to get token prices: ${fromTokenPrice?.error || toTokenPrice?.error}`);
            }

            // Check pool reserves before proceeding
            const hasLiquidity = await checkPoolReserves(fromToken, toToken, amount);
            if (!hasLiquidity) {
                throw new Error("Insufficient liquidity for swap");
            }

            // Get quote to verify price impact
            const quote = await getQuoteForRoute(fromToken, toToken, amount, this);
            if (quote.impact > 10) { // 10% max price impact
                throw new Error(`Price impact too high: ${quote.impact}%`);
            }

            // Get optimal route with fallback support
            const route = await getOptimalSwapRoute(
                fromToken,
                toToken,
                amount
            );

            // Execute swap with fallback support
            const result = await executeSwapWithRoute(
                this.connection,
                keypair,
                route,
                amount
            );

            // Calculate entry price using the cached prices
            const entryPrice = amount * fromTokenPrice.price / (result.outputAmount * toTokenPrice.price);

            // Create swap memory with correct userId
            const swapMemory: Memory = {
                id: stringToUuid(`swap-${result.signature}-${Date.now()}`),
                userId: userId as UUID,
                agentId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                content: {
                    type: "swap",
                    status: "completed",
                    inputToken: fromToken,
                    outputToken: toToken,
                    inputAmount: amount,
                    outputAmount: result.outputAmount,
                    price: toTokenPrice.price,
                    entryPrice: entryPrice,
                    timestamp: Date.now(),
                    txSignature: result.signature,
                    text: `Swapped ${amount} ${fromToken} for ${toToken}`,
                    isTreasurySwap: userId === this.runtime.agentId,
                    proposerId: userId !== this.runtime.agentId ? userId : undefined
                }
            };

            // Store the swap memory
            await this.runtime.messageManager.createMemory(swapMemory);

            // Log successful swap with detailed information
            elizaLogger.info(`Strategy swap executed for user ${userId}`, {
                fromToken,
                toToken,
                amount,
                txSignature: result.signature,
                fromPrice: fromTokenPrice,
                toPrice: toTokenPrice,
                entryPrice: entryPrice,
                route: route.bestRoute,
                priceImpact: quote.impact,
                minOutput: quote.minOutput
            });

            return swapId;
        });
    }

    async verifyTransaction(signature: string): Promise<boolean> {
        try {
            const tx = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            return tx !== null && tx.meta?.err === null;
        } catch (error) {
            elizaLogger.error(`Error verifying transaction ${signature}:`, error);
            return false;
        }
    }
}