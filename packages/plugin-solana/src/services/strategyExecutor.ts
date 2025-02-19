// packages/plugin-solana/src/services/strategyExecutor.ts

import { Service, ServiceType, elizaLogger, stringToUuid, IAgentRuntime } from "@elizaos/core";
import { StrategyContent, StrategyExecution, PositionUpdate, StrategyExecutionRequest } from "../shared/types/strategy";
import { SwapRequest } from "../shared/types/treasury";
import { createStrategyMemoryContent } from "../shared/types/memory";
import { Position, PositionTracker, StrategyConfig } from "../providers/positionTracker.js";
import { SwapService } from "../services/swapService.js";
import { getQuoteForRoute } from "../actions/swap.js";

export class StrategyExecutor extends Service {
    static get serviceType(): ServiceType {
        return "STRATEGY_EXECUTOR" as ServiceType;
    }

    private positionTracker: PositionTracker;
    private swapService: SwapService;
    private monitoringInterval: NodeJS.Timeout | null = null;
    protected runtime: IAgentRuntime;
    private activeMonitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

    constructor(
        runtime: IAgentRuntime,
        positionTracker: PositionTracker,
        swapService: SwapService
    ) {
        super();
        this.runtime = runtime;
        this.positionTracker = positionTracker;
        this.swapService = swapService;
    }

    async initialize(): Promise<void> {
        elizaLogger.info("Strategy executor service initialized");
    }

    async startStrategyMonitoring(userId: string): Promise<void> {
        // Check if monitoring is already active for this user
        if (this.activeMonitoringIntervals.has(userId)) {
            elizaLogger.debug(`Strategy monitoring already active for user ${userId}`);
            return;
        }

        const interval = setInterval(async () => {
            try {
                const position = await this.positionTracker.getLatestPosition(userId);
                if (!position) {
                    this.stopStrategyMonitoring(userId);
                    return;
                }

                const priceInfo = await this.swapService.getTokenPrice(position.token);
                if (!priceInfo) {
                    elizaLogger.warn(`Could not get current price for token ${position.token}`);
                    return;
                }

                await this.checkAndExecuteExits(position, priceInfo.price, userId);
            } catch (error) {
                elizaLogger.error(`Error in strategy monitoring for user ${userId}:`, error);
            }
        }, 60000); // Check every minute

        this.activeMonitoringIntervals.set(userId, interval);
        elizaLogger.info(`Started strategy monitoring for user ${userId}`);
    }

    stopStrategyMonitoring(userId: string): void {
        const interval = this.activeMonitoringIntervals.get(userId);
        if (interval) {
            clearInterval(interval);
            this.activeMonitoringIntervals.delete(userId);
            elizaLogger.info(`Stopped strategy monitoring for user ${userId}`);
        }
    }

    // Add cleanup method for proper shutdown
    cleanup(): void {
        for (const [userId, interval] of this.activeMonitoringIntervals.entries()) {
            clearInterval(interval);
            elizaLogger.info(`Cleaned up strategy monitoring for user ${userId}`);
        }
        this.activeMonitoringIntervals.clear();
    }

    private async checkAndExecuteExits(position: Position, currentPrice: number, userId: string): Promise<void> {
        // Update trailing stop if applicable
        if (position.strategy?.stopLoss?.isTrailing) {
            const stopLoss = position.strategy.stopLoss;
            const highestPrice = stopLoss.highestPrice || position.entryPrice;

            // Update highest price if we have a new high
            if (currentPrice > highestPrice) {
                stopLoss.highestPrice = currentPrice;
                // Update stop loss price to maintain the trailing distance
                stopLoss.price = currentPrice * (1 - (stopLoss.trailingDistance! / 100));

                elizaLogger.info(`Updated trailing stop for position ${position.id}`, {
                    newHigh: currentPrice,
                    newStopPrice: stopLoss.price,
                    trailingDistance: stopLoss.trailingDistance
                });
            }
        }

        // Check take profit levels
        for (const tp of position.strategy!.takeProfitLevels) {
            if (!tp.price || currentPrice < tp.price) continue;

            const sellAmount = (tp.sellAmount / 100) * position.remainingAmount!;
            const remainingAfterSell = position.remainingAmount! - sellAmount;

            try {
                const txSignature = await this.swapService.executeSwap(
                    position.token,
                    "USDC", // Using USDC as default stable coin
                    sellAmount,
                    userId
                );

                if (await this.swapService.verifyTransaction(txSignature)) {
                    await this.positionTracker.updatePositionAmount(
                        position.id,
                        sellAmount,
                        remainingAfterSell,
                        currentPrice,
                        'take_profit',
                        txSignature
                    );

                    elizaLogger.info(`Take profit executed for position ${position.id}`, {
                        price: currentPrice,
                        soldAmount: sellAmount,
                        remaining: remainingAfterSell,
                        txSignature
                    });
                }
            } catch (error) {
                elizaLogger.error(`Error executing take profit for position ${position.id}:`, error);
            }
        }

        // Check stop loss
        if (position.strategy!.stopLoss?.price && currentPrice <= position.strategy!.stopLoss.price) {
            try {
                const txSignature = await this.swapService.executeSwap(
                    position.token,
                    "USDC",
                    position.remainingAmount!,
                    userId
                );

                if (await this.swapService.verifyTransaction(txSignature)) {
                    await this.positionTracker.updatePositionAmount(
                        position.id,
                        position.remainingAmount!,
                        0,
                        currentPrice,
                        'stop_loss',
                        txSignature
                    );

                    elizaLogger.info(`Stop loss executed for position ${position.id}`, {
                        price: currentPrice,
                        soldAmount: position.remainingAmount,
                        txSignature
                    });
                }
            } catch (error) {
                elizaLogger.error(`Error executing stop loss for position ${position.id}:`, error);
            }
        }
    }

    async attachStrategy(position: Position, strategy: StrategyConfig): Promise<void> {
        try {
            await this.positionTracker.attachStrategy(position, strategy);
            elizaLogger.info(`Strategy attached to position ${position.id}`, { strategy });
        } catch (error) {
            elizaLogger.error(`Error attaching strategy to position ${position.id}:`, error);
            throw error;
        }
    }

    async executeStrategy(strategy: StrategyContent, position: PositionUpdate): Promise<void> {
        try {
            const executionSize = await this.calculateExecutionSize(strategy, position);
            if (!executionSize) {
                throw new Error("Could not determine execution size");
            }

            // Create execution request
            const request: StrategyExecutionRequest = {
                type: "strategy_execution_request",
                id: stringToUuid(`exec-${strategy.id}`),
                strategyId: strategy.id,
                token: strategy.token,
                baseToken: strategy.baseToken,
                amount: executionSize.toString(),
                price: position.price,
                executionType: strategy.strategyType,
                requestId: stringToUuid(`req-${strategy.id}-${Date.now()}`),
                text: `Executing ${strategy.strategyType} strategy for ${strategy.token}`,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            // Create swap request
            const swapRequest: SwapRequest = {
                type: "swap_request",
                id: stringToUuid(`swap-${strategy.id}`),
                fromToken: position.token,
                toToken: position.baseToken,
                amount: executionSize.toString(),
                reason: "strategy_triggered",
                requestId: stringToUuid(`req-${strategy.id}-${Date.now()}`),
                sourceAgent: "STRATEGY",
                sourceId: strategy.id,
                status: "pending_execution",
                text: `Swap request from triggered strategy ${strategy.id}`,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            // Create execution tracking memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`exec-${strategy.id}`),
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: createStrategyMemoryContent(
                    "strategy_execution",
                    `Executing ${strategy.strategyType} strategy for ${position.token}`,
                    "pending_execution",
                    strategy.id,
                    {
                        tags: ["execution", position.token],
                        priority: "high"
                    }
                )
            });

            // Create swap request memory
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`swap-${strategy.id}`),
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: swapRequest
            });

            // Get quote to verify price impact
            const quote = await getQuoteForRoute(position.token, position.baseToken, executionSize, this.swapService);
            if (quote.impact > 10) { // 10% max price impact
                throw new Error(`Price impact too high: ${quote.impact}%`);
            }

            elizaLogger.info(`Strategy execution initiated for ${strategy.id}`);
        } catch (error) {
            elizaLogger.error("Error executing strategy:", error);
            throw error;
        }
    }

    private async calculateExecutionSize(strategy: StrategyContent, position: PositionUpdate): Promise<number | null> {
        try {
            const positionSize = parseFloat(position.size);
            const currentPrice = parseFloat(position.price);
            
            // Handle take profit points
            if (strategy.takeProfitPoints) {
                for (const tp of strategy.takeProfitPoints) {
                    if (currentPrice >= parseFloat(tp.price)) {
                        return positionSize * (tp.percentage / 100);
                    }
                }
            }

            // Handle stop loss
            if (strategy.stopLossPoint && currentPrice <= parseFloat(strategy.stopLossPoint.price)) {
                return positionSize;
            }

            // Handle trailing stop
            if (strategy.trailingStopDistance) {
                const trailingStop = currentPrice * (1 - parseFloat(strategy.trailingStopDistance) / 100);
                if (currentPrice <= trailingStop) {
                    return positionSize;
                }
            }

            return null;
        } catch (error) {
            elizaLogger.error("Error calculating execution size:", error);
            return null;
        }
    }

    async validateStrategy(strategy: StrategyContent): Promise<boolean> {
        // Basic validation
        if (!strategy.token || !strategy.baseToken) {
            return false;
        }

        // Validate take profit points
        if (strategy.takeProfitPoints?.some(tp => !tp.price || !tp.percentage)) {
            return false;
        }

        // Validate stop loss
        if (strategy.stopLossPoint && (!strategy.stopLossPoint.price || !strategy.stopLossPoint.percentage)) {
            return false;
        }

        // Validate trailing stop
        if (strategy.trailingStopDistance && parseFloat(strategy.trailingStopDistance) <= 0) {
            return false;
        }

        return true;
    }
}