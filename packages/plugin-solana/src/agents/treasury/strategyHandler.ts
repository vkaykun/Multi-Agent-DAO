// Treasury Agent Strategy Handler
// Contains logic for handling strategy execution

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
} from "@elizaos/core";
import {
  BaseContent,
  ContentStatus,
  SwapRequest,
} from "../../shared/types/base.ts";
import { StrategyExecutionRequest } from "../../shared/types/strategy.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { TreasuryAgent } from "./TreasuryAgent.ts";
import { ITreasuryAgentForHandlers } from "./types/handlerTypes.ts";

/**
 * Specialized strategy execution request with additional fields
 */
interface ExtendedStrategyExecutionRequest extends StrategyExecutionRequest {
  stopLoss?: {
    percentage: number;
    price?: number;
    isTrailing?: boolean;
    trailingDistance?: number;
    highestPrice?: number;
  };
  strategyType?: "TRAILING_STOP" | "TAKE_PROFIT" | "STOP_LOSS";
}

/**
 * Handle a strategy execution request
 */
export async function handleStrategyExecution(agent: TreasuryAgent, request: ExtendedStrategyExecutionRequest): Promise<void> {
  try {
    // Validate request
    if (!await validateStrategyExecution(agent, request)) {
      throw new Error("Invalid strategy execution request");
    }

    const amountNum = parseFloat(request.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error(`Invalid amount: ${request.amount}`);
    }

    // Acquire lock for strategy execution
    const lock = await agent.acquireDistributedLock(`strategy-${request.strategyId}`);
    if (!lock) {
      throw new Error("Could not acquire strategy execution lock");
    }

    try {
      // Handle trailing stop logic if applicable
      if (request.strategyType === "TRAILING_STOP" && request.stopLoss?.isTrailing) {
        const currentPrice = await agent.swapService.getTokenPrice(request.token);
        if (!currentPrice || currentPrice.error) {
          throw new Error("Could not get current token price");
        }

        // Update highest price if needed
        if (!request.stopLoss.highestPrice || currentPrice.price > request.stopLoss.highestPrice) {
          request.stopLoss.highestPrice = currentPrice.price;
          elizaLogger.info(`Updated highest price for strategy ${request.strategyId} to ${currentPrice.price}`);
          return; // Exit early since we just updated the high
        }

        // Check if price has fallen below trailing stop threshold
        const stopPrice = request.stopLoss.highestPrice * (1 - (request.stopLoss.trailingDistance! / 100));
        if (currentPrice.price > stopPrice) {
          elizaLogger.debug(`Current price ${currentPrice.price} above stop price ${stopPrice}, no action needed`);
          return;
        }

        elizaLogger.info(`Trailing stop triggered for strategy ${request.strategyId} at ${currentPrice.price} (stop price: ${stopPrice})`);
      }

      // Create swap request instead of direct execution
      const swapRequest: SwapRequest = {
        type: "swap_request",
        id: stringToUuid(`strategy-swap-${request.id}`),
        fromToken: request.token,
        toToken: request.baseToken,
        amount: request.amount,
        reason: "strategy_triggered",
        requestId: request.requestId,
        sourceAgent: "STRATEGY",
        sourceId: request.strategyId,
        status: "pending_execution",
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        text: `Strategy-triggered swap for ${request.strategyId}`
      };

      // Process through handleSwapRequest
      try {
        // Use swap handler directly
        const swapHandlerModule = await import("./swapHandler.ts");
        
        // Get keypair before executing swap
        const keypair = await agent.getKeyPair();
        const agentWithKeypair = {
          ...agent,
          getKeyPair: () => keypair,
          getRuntime: agent.getRuntime.bind(agent),
          getAgentId: agent.getAgentId.bind(agent),
          getAgentType: agent.getAgentType.bind(agent),
          getConnection: agent.getConnection.bind(agent),
          getSetting: agent.getSetting.bind(agent),
          createMemoryPublic: agent.createMemoryPublic.bind(agent),
          acquireDistributedLock: agent.acquireDistributedLock.bind(agent),
          releaseDistributedLock: agent.releaseDistributedLock.bind(agent),
          getTreasuryAddress: agent.getTreasuryAddress.bind(agent),
          sendMessage: agent.sendMessage.bind(agent),
          quickTokenValidation: agent.quickTokenValidation.bind(agent),
          quickSecurityCheck: agent.quickSecurityCheck.bind(agent),
          swapService: agent.swapService,
          walletProvider: agent.walletProvider,
          tokenProvider: agent.tokenProvider,
          agentSettings: agent.agentSettings
        } as ITreasuryAgentForHandlers;

        const result = await swapHandlerModule.handleSwapRequest(agentWithKeypair, swapRequest);

        // Create success result content
        const resultContent: BaseContent = {
          type: "strategy_execution_result",
          id: stringToUuid(`result-${request.id}`),
          text: `Successfully executed strategy ${request.strategyId}`,
          agentId: agent.getAgentId(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "executed",
          requestId: request.requestId,
          success: true,
          txSignature: result.signature,
          executedAmount: request.amount,
          executionPrice: result.price
        };

        // Store result in memory
        await agent.createMemoryPublic(resultContent);

        // Send result message
        await agent.sendMessage({
          type: "strategy_execution_result",
          content: resultContent,
          from: agent.getAgentType(),
          to: "ALL"
        });

        elizaLogger.info(`Strategy execution completed: ${request.strategyId}`);
      } catch (error) {
        throw new Error(`Swap failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      await agent.releaseDistributedLock(lock);
    }
  } catch (error) {
    elizaLogger.error("Error executing strategy:", error);

    // Create failure result content
    const errorContent: BaseContent = {
      type: "strategy_execution_result",
      id: stringToUuid(`result-${request.id}`),
      text: `Failed to execute strategy ${request.strategyId}`,
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "failed",
      requestId: request.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };

    // Store result in memory
    await agent.createMemoryPublic(errorContent);

    // Send result message
    await agent.sendMessage({
      type: "strategy_execution_result",
      content: errorContent,
      from: agent.getAgentType(),
      to: "ALL"
    });
  }
}

/**
 * Validate strategy execution request
 */
async function validateStrategyExecution(agent: TreasuryAgent, request: StrategyExecutionRequest): Promise<boolean> {
  // Validate the request has required fields
  if (!request.token || !request.baseToken || !request.amount) {
    return false;
  }

  try {
    // Check if we have sufficient balance
    const balance = await agent.walletProvider.fetchPortfolioValue(agent.getRuntime());
    const tokenBalance = balance.items.find(item => item.address === request.token);
    
    if (!tokenBalance || parseFloat(tokenBalance.uiAmount) < parseFloat(request.amount)) {
      elizaLogger.warn("Insufficient balance for strategy execution:", {
        required: request.amount,
        available: tokenBalance?.uiAmount || "0"
      });
      return false;
    }

    return true;
  } catch (error) {
    elizaLogger.error("Error validating strategy execution:", error);
    return false;
  }
} 