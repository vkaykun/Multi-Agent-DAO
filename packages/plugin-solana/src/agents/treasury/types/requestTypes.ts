// Treasury Agent Request Types
// Contains request-specific types for the Treasury Agent

import { UUID } from "@elizaos/core";
import { BaseContent, ContentStatus } from "../../../shared/types/base.ts";

// Registration request/response types
export interface RegisterValidationResult {
  isValid: boolean;
  walletAddress: string;
  reason: string;
}

export interface RegisterState {
  walletAddress: string;
  bio: string;
  lore: string;
  messageDirections: string;
  postDirections: string;
  roomId: UUID;
  userId?: UUID;
  agentId?: UUID;
  actors: string;
  actorsData?: any[];
  goals?: string;
  goalsData?: any[];
  recentMessages: string;
  recentMessagesData: any[];
  actionNames?: string;
}

// Transfer and swap request types
export interface TransferState {
  pendingTransfer?: {
    recipient: string;
    amount: number;
    token: string;
    tokenAddress?: string;
    confirmed?: boolean;
    network?: string;
    currentBalance?: number;
    timestamp: number;
  };
  transactionComplete?: boolean;
  lastProcessedMessageId?: string;
  [key: string]: any;
}

export interface SwapContext {
  swapService: any;
  connection: any;
  keypair: any;
}

export interface SwapExecutionResult extends BaseContent {
  type: "swap_execution_result";
  proposalId: UUID;
  swapId: UUID;
  success: boolean;
  error?: string;
  executedBy: UUID;
  timestamp: number;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount?: string;
}

// Jupiter API-related types
export interface JupiterQuoteResponse {
  error?: string;
  outAmount?: string;
  routePlan?: any[];
  priceImpactPct?: number;
  outAmountWithSlippage?: string;
}

// Generic result types
export interface GenerateObjectResult<T> {
  inputTokenCA?: string;
  outputTokenCA?: string;
  amount?: number;
  inputTokenSymbol?: string;
  outputTokenSymbol?: string;
  [key: string]: any;
}

// Message interpretation types?
export interface TreasuryInterpretation {
  actionType: "register" | "deposit" | "verify" | "balance" | "unknown";
  // For registration
  walletAddress?: string;
  // For verification
  transactionSignature?: string;
  // Common fields
  confidence: number;
  reason?: string;
}

// Command parsing types
export interface SwapDetails {
  type: 'swap';
  inputToken: string;
  outputToken: string;
  amount: string;
}

// Error handling types
export interface ErrorLogObject {
  error: string;
  [key: string]: unknown;
} 