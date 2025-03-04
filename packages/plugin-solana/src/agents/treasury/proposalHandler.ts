// Treasury Agent Proposal Handler
// Contains logic for handling proposals

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
import { ROOM_IDS } from "../../shared/constants.ts";
import { TreasuryAgent } from "./TreasuryAgent.ts";
import * as swapHandler from "./swapHandler.ts";
import { ProposalType } from "../../shared/types/proposal.ts";
import { ITreasuryAgentForHandlers } from "./types/handlerTypes.ts";

/**
 * Interface for proposal content
 */
interface ProposalContent extends BaseContent {
  interpretation?: {
    details: {
      type: string;
      [key: string]: any;
    };
  };
  title: string;
  description: string;
  proposer: UUID;
  yes: UUID[];
  no: UUID[];
  deadline: number;
  voteStats: {
    total: number;
    yes: number;
    no: number;
    totalVotingPower: number;
    totalYesPower: number;
    totalNoPower: number;
    yesPowerPercentage: number;
    quorumReached: boolean;
    minimumYesVotesReached: boolean;
    minimumPercentageReached: boolean;
  };
}

/**
 * Type for swap details
 */
interface SwapDetails {
  type: 'swap';
  inputToken: string;
  outputToken: string;
  amount: string;
}

/**
 * Type guard to check if proposal has swap details
 */
function isProposalWithSwap(content: ProposalContent): boolean {
  if (!content.interpretation || typeof content.interpretation !== 'object') {
    return false;
  }
  
  const details = content.interpretation.details;
  if (!details || typeof details !== 'object') {
    return false;
  }

  return 'inputToken' in details &&
    'outputToken' in details &&
    'amount' in details;
}

/**
 * Handle a proposal event (creation or update)
 */
export async function handleProposalEvent(agent: TreasuryAgent, content: ProposalContent): Promise<void> {
  // For base proposals and creation events, we just log and track
  elizaLogger.info(`Processing proposal event: ${content.id}`);
  
  // Get the proposal type, safely cast it to ProposalType if valid
  let proposalType: ProposalType | undefined;
  
  if (content.interpretation?.details.type) {
    const typeStr = content.interpretation.details.type as string;
    if (typeStr === 'swap' || typeStr === 'strategy' || 
        typeStr === 'governance' || typeStr === 'parameter_change') {
      proposalType = typeStr as ProposalType;
    }
  }

  // Create tracking record
  await agent.createMemoryPublic({
    type: "proposal_tracked",
    id: stringToUuid(`proposal-track-${content.id}`),
    text: `Tracking proposal ${content.id}`,
    status: "executed",
    agentId: agent.getAgentId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      proposalId: content.id,
      proposalType,
      timestamp: Date.now()
    }
  });
}

/**
 * Handle a proposal that has passed and needs execution
 */
export async function handleProposalExecution(agent: TreasuryAgent, content: ProposalContent): Promise<void> {
  try {
    if (!isProposalWithSwap(content)) {
      elizaLogger.warn("Proposal does not contain swap details");
      return;
    }

    const details = content.interpretation!.details as SwapDetails;
    const swapRequest: SwapRequest = {
      type: "swap_request",
      id: stringToUuid(`swap-${content.id}`),
      fromToken: details.inputToken,
      toToken: details.outputToken,
      amount: details.amount,
      status: "pending_execution",
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reason: "proposal_passed",
      requestId: content.id,
      sourceAgent: "TREASURY",
      sourceId: content.id,
      text: `Executing swap from proposal ${content.id}`
    };

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

    // Execute the swap using the swapHandler
    await swapHandler.handleSwapRequest(agentWithKeypair, swapRequest);
    
    // Update proposal status
    await agent.createMemoryPublic({
      type: "proposal_execution_result",
      id: stringToUuid(`execution-result-${content.id}`),
      text: `Proposal ${content.id} execution initiated`,
      status: "executed",
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        proposalId: content.id,
        executedAt: Date.now(),
        executionType: "swap"
      }
    });
  } catch (error) {
    elizaLogger.error("Error executing proposal:", error);
    
    // Record failure
    await agent.createMemoryPublic({
      type: "proposal_execution_result",
      id: stringToUuid(`execution-result-${content.id}`),
      text: `Proposal ${content.id} execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      status: "failed",
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        proposalId: content.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      }
    });
    
    throw error;
  }
}

/**
 * Handle post-execution updates
 */
export async function handleProposalExecuted(agent: TreasuryAgent, content: ProposalContent): Promise<void> {
  // Handle any post-execution updates or notifications
  if (content.interpretation?.details.type === 'swap') {
    // Update swap-related state if needed
    await updateSwapState(agent, content);
  }
  
  // Log the execution
  elizaLogger.info(`Proposal ${content.id} executed successfully`);
}

/**
 * Update swap state after execution
 */
async function updateSwapState(agent: TreasuryAgent, proposal: ProposalContent): Promise<void> {
  if (!isProposalWithSwap(proposal)) return;
  
  const details = proposal.interpretation!.details as SwapDetails;
  
  // Update any swap-related state, balances, etc.
  await agent.createMemoryPublic({
    type: "swap_state_updated",
    id: stringToUuid(`swap-state-${proposal.id}`),
    text: `Updated swap state for proposal ${proposal.id}`,
    status: "executed",
    agentId: agent.getAgentId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      proposalId: proposal.id,
      swapDetails: {
        maxSlippage: 1.0, // Default 1% slippage
        minOutputAmount: 0 // Will be calculated based on amount and price
      }
    }
  });
} 