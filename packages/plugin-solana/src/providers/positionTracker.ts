// packages/plugin-solana/src/providers/positionTracker.ts

import { IAgentRuntime, elizaLogger, stringToUuid } from "@elizaos/core";
import { ENDPOINTS } from "../endpoints";

interface DexScreenerResponse {
    pairs: Array<{
        liquidity?: { usd?: number };
        priceUsd?: string;
    }>;
}

async function getCurrentPrice(token: string): Promise<number> {
    try {
        const response = await fetch(
            `${ENDPOINTS.DEXSCREENER_API}/tokens/${token}`
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

        return Number(bestPair.priceUsd);
    } catch (error) {
        elizaLogger.error(`Error getting DexScreener price for ${token}:`, error);
        throw error;
    }
}

export interface Position {
    id: string;
    txSignature: string;
    token: string;
    amount: number;
    entryPrice: number;
    timestamp: number;
    strategy?: StrategyConfig;
    status: 'active' | 'closed';
    userId: string;
    remainingAmount?: number;
    partialSells?: Array<{
        timestamp: number;
        amount: number;
        price: number;
        type: 'take_profit' | 'stop_loss';
        txSignature?: string;
        profitPercentage?: number;
    }>;
}

export interface StrategyConfig {
    takeProfitLevels: Array<{
        percentage: number;    // e.g., 100 for 2x (100% gain)
        sellAmount: number;    // percentage of position to sell
        price?: number;       // calculated based on entry price
    }>;
    stopLoss?: {
        percentage: number;    // e.g., 20 for 20% loss
        price?: number;       // calculated based on entry price
        isTrailing?: boolean; // whether this is a trailing stop
        trailingDistance?: number; // distance to maintain from highest price (in %)
        highestPrice?: number; // tracks the highest price seen
    };
}

export class PositionTracker {
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    async getLatestPosition(userId: string): Promise<Position | null> {
        try {
            const swaps = await this.runtime.messageManager.getMemories({
                roomId: this.runtime.agentId,
                count: 100
            });

            // For treasury positions, also include swaps marked as treasury swaps
            const latestSwap = swaps
                .filter(m =>
                    m.userId === userId ||
                    (userId === this.runtime.agentId && m.content.isTreasurySwap === true)
                )
                .find(m => m.content.type === "swap" && m.content.status === "completed");

            if (!latestSwap || !latestSwap.id) {
                elizaLogger.debug(`No recent swap found for user ${userId}`);
                return null;
            }

            // Get position updates to calculate remaining amount
            const updates = await this.runtime.messageManager.getMemories({
                roomId: this.runtime.agentId,
                count: 100
            });

            const positionUpdates = updates
                .filter(m =>
                    m.content.type === "position_update" &&
                    m.content.positionId === latestSwap.id
                )
                .sort((a, b) => (b.content.timestamp as number) - (a.content.timestamp as number));

            const initialAmount = latestSwap.content.outputAmount as number;
            let remainingAmount = initialAmount;
            const partialSells = [];

            // Calculate remaining amount and collect partial sells
            for (const update of positionUpdates) {
                remainingAmount = update.content.remainingAmount as number;
                partialSells.push({
                    timestamp: update.content.timestamp as number,
                    amount: update.content.soldAmount as number,
                    price: update.content.price as number,
                    type: update.content.sellType as 'take_profit' | 'stop_loss',
                    txSignature: update.content.txSignature as string,
                    profitPercentage: ((update.content.price as number) - (latestSwap.content.price as number)) / (latestSwap.content.price as number) * 100
                });
            }

            // Get active strategy if exists
            const strategy = await this.getActiveStrategy(latestSwap.id);

            return {
                id: latestSwap.id,
                txSignature: latestSwap.content.txSignature as string,
                token: latestSwap.content.outputToken as string,
                amount: initialAmount,
                remainingAmount: remainingAmount,
                entryPrice: latestSwap.content.entryPrice as number || latestSwap.content.price as number || 0,
                timestamp: latestSwap.content.timestamp as number,
                status: remainingAmount > 0 ? 'active' : 'closed',
                userId,
                partialSells: partialSells.length > 0 ? partialSells : undefined,
                strategy: strategy || undefined
            };
        } catch (error) {
            elizaLogger.error(`Error getting latest position for user ${userId}:`, error);
            return null;
        }
    }

    async attachStrategy(position: Position, strategy: StrategyConfig): Promise<void> {
        try {
            // Calculate price levels based on entry price
            const strategyWithPrices: StrategyConfig = {
                takeProfitLevels: strategy.takeProfitLevels.map(tp => ({
                    ...tp,
                    price: position.entryPrice * (1 + tp.percentage / 100)
                })),
                stopLoss: strategy.stopLoss ? {
                    ...strategy.stopLoss,
                    price: position.entryPrice * (1 - strategy.stopLoss.percentage / 100)
                } : undefined
            };

            const memoryId = stringToUuid(`strategy-${position.id}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Strategy attached to position ${position.id}`,
                    type: "strategy",
                    positionId: position.id,
                    strategy: strategyWithPrices,
                    status: "active",
                    token: position.token,
                    entryPrice: position.entryPrice,
                    timestamp: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: stringToUuid(position.userId),
                agentId: this.runtime.agentId
            });

            elizaLogger.info(`Strategy attached to position ${position.id}`, {
                strategy: strategyWithPrices,
                position
            });
        } catch (error) {
            elizaLogger.error(`Error attaching strategy to position ${position.id}:`, error);
            throw error;
        }
    }

    async updatePositionAmount(
        positionId: string,
        soldAmount: number,
        remainingAmount: number,
        price: number,
        type: 'take_profit' | 'stop_loss',
        txSignature?: string
    ): Promise<void> {
        try {
            const position = await this.getPositionById(positionId);
            if (!position) {
                throw new Error(`Position ${positionId} not found`);
            }

            const profitPercentage = ((price - position.entryPrice) / position.entryPrice) * 100;

            const memoryId = stringToUuid(`position-update-${positionId}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Updated position ${positionId} - Sold ${soldAmount} at ${price}`,
                    type: "position_update",
                    positionId,
                    soldAmount,
                    remainingAmount,
                    price,
                    sellType: type,
                    txSignature,
                    profitPercentage,
                    timestamp: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: stringToUuid(this.runtime.agentId),
                agentId: this.runtime.agentId
            });

            // If position is fully closed, update its status
            if (remainingAmount <= 0) {
                await this.updatePositionStatus(positionId, "closed");
            }
        } catch (error) {
            elizaLogger.error(`Error updating position amount for ${positionId}:`, error);
            throw error;
        }
    }

    private async getPositionById(positionId: string): Promise<Position | null> {
        const memories = await this.runtime.messageManager.getMemories({
            roomId: this.runtime.agentId,
            count: 100
        });

        const positionMem = memories.find(m => m.id === positionId);
        if (!positionMem) return null;

        return this.getLatestPosition(positionMem.userId);
    }

    async updatePositionStatus(positionId: string, status: 'active' | 'closed'): Promise<void> {
        try {
            const memoryId = stringToUuid(`position-status-${positionId}-${Date.now()}`);
            await this.runtime.messageManager.createMemory({
                id: memoryId,
                content: {
                    text: `Updated position ${positionId} status to ${status}`,
                    type: "position_status",
                    positionId,
                    status,
                    timestamp: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: stringToUuid(this.runtime.agentId),
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error(`Error updating position ${positionId} status:`, error);
            throw error;
        }
    }

    async getActiveStrategy(positionId: string): Promise<StrategyConfig | null> {
        try {
            const memories = await this.runtime.messageManager.getMemories({
                roomId: this.runtime.agentId,
                count: 100
            });

            const strategyMem = memories
                .filter(m =>
                    m.content.type === "strategy" &&
                    m.content.positionId === positionId &&
                    m.content.status === "active"
                )
                .sort((a, b) => (b.content.timestamp as number) - (a.content.timestamp as number))[0];

            if (!strategyMem) return null;

            return strategyMem.content.strategy as StrategyConfig;
        } catch (error) {
            elizaLogger.error(`Error getting active strategy for position ${positionId}:`, error);
            return null;
        }
    }

    async getCurrentPrice(token: string): Promise<number> {
        try {
            return await getCurrentPrice(token);
        } catch (error) {
            elizaLogger.error(`Error getting current price for ${token}:`, error);
            throw error;
        }
    }

    async cancelStrategy(positionId: string): Promise<void> {
        try {
            // Find the original strategy memory
            const memories = await this.runtime.messageManager.getMemories({
                roomId: this.runtime.agentId,
                count: 100
            });

            const strategyMem = memories.find(m =>
                m.content.type === "strategy" &&
                m.content.positionId === positionId &&
                m.content.status === "active"
            );

            if (!strategyMem) {
                elizaLogger.warn(`No active strategy found for position ${positionId}`);
                return;
            }

            // Create a new memory with the same ID but updated status
            await this.runtime.messageManager.createMemory({
                id: strategyMem.id, // Use same ID to update existing memory
                content: {
                    ...strategyMem.content,
                    text: `Strategy cancelled for position ${positionId}`,
                    status: "cancelled",
                    cancelledAt: Date.now()
                },
                roomId: this.runtime.agentId,
                userId: strategyMem.userId,
                agentId: this.runtime.agentId
            });

            elizaLogger.info(`Strategy cancelled for position ${positionId}`);
        } catch (error) {
            elizaLogger.error(`Error cancelling strategy for position ${positionId}:`, error);
            throw error;
        }
    }
}
