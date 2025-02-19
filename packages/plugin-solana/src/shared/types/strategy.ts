// packages/plugin-solana/src/shared/types/strategy.ts

import { UUID } from "@elizaos/core";
import { BaseContent, ContentStatus, MemoryMetadata } from "./base";
import { DAOMemoryType } from "./memory";

export type StrategyType = 
    | "TAKE_PROFIT"
    | "STOP_LOSS"
    | "TRAILING_STOP"
    | "DCA"
    | "GRID"
    | "REBALANCE";

export type StrategyStatus = ContentStatus;

export interface PricePoint {
    price: string;
    percentage: number;
    amount?: string;
}

export interface StrategyCondition {
    type: "PRICE" | "TIME" | "VOLUME" | "CUSTOM";
    operator: ">" | "<" | "==" | ">=" | "<=";
    value: string;
    timeframe?: string;
}

export interface StrategyContent extends BaseContent {
    type: Extract<DAOMemoryType, "strategy" | `strategy_${string}`>;
    strategyType: StrategyType;
    token: string;
    baseToken: string;
    entryPrice?: string;
    takeProfitPoints?: PricePoint[];
    stopLossPoint?: PricePoint;
    trailingStopDistance?: string;
    conditions: StrategyCondition[];
    maxSlippage?: string;
    timeframe?: {
        start: number;
        end?: number;
    };
    sourceProposalId?: UUID;
    proposalStatus?: ContentStatus;
    status: StrategyStatus;
}

export interface StrategyExecution extends BaseContent {
    type: "strategy_execution";
    strategyId: UUID;
    triggered: StrategyCondition[];
    txHash?: string;
    priceAtExecution: string;
    amountExecuted: string;
    success: boolean;
    error?: string;
}

export interface PositionUpdate extends BaseContent {
    type: "position_update";
    token: string;
    baseToken: string;
    price: string;
    size: string;
    value: string;
    pnl?: {
        percentage: string;
        absolute: string;
    };
    activeStrategies: UUID[];
}

export interface StrategyExecutionRequest extends BaseContent {
    type: "strategy_execution_request";
    strategyId: string;
    token: string;
    baseToken: string;
    amount: string;
    price: string;
    executionType: StrategyType;
    requestId: string;
}

export interface StrategyExecutionResult extends BaseContent {
    type: "strategy_execution_result";
    requestId: string;
    success: boolean;
    txSignature?: string;
    error?: string;
    executedAmount?: string;
    executionPrice?: string;
} 