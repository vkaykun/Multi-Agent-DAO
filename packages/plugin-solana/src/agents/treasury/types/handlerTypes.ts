// Treasury Agent Handler Types
// Contains type definitions for handler interfaces

import { UUID, Content } from "@elizaos/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ContentStatus, BaseContent, AgentType, DistributedLock } from "../../../shared/types/base.ts";
import { SwapService } from "../../../services/swapService.ts";
import { TokenProvider } from "../../../providers/token.ts";
import { WalletProvider } from "../../../providers/wallet.ts";
import { ExtendedAgentRuntime } from "../../../shared/utils/runtime.ts";

/**
 * Interface defining the required methods that handlers can access on the TreasuryAgent
 */
export interface ITreasuryAgentForHandlers {
  // Runtime and agent identification
  getRuntime(): ExtendedAgentRuntime;
  getAgentId(): UUID;
  getAgentType(): AgentType;
  
  // Blockchain connection methods
  getConnection(): Connection | null;
  getTreasuryAddress(): string | null;
  getKeyPair(): Keypair | null;
  
  // Configuration methods
  getSetting(key: string): string | undefined;
  
  // Memory and message handling
  createMemoryPublic(content: BaseContent): Promise<void>;
  sendMessage(message: any): Promise<void>;
  
  // Treasury-specific methods
  quickTokenValidation(tokenAddress: string): Promise<boolean>;
  quickSecurityCheck(tokenCA: string): Promise<boolean>;
  
  // Lock management
  acquireDistributedLock(key: string, timeoutMs?: number): Promise<DistributedLock | null>;
  releaseDistributedLock(lock: DistributedLock): Promise<void>;
  
  // Service access
  readonly tokenProvider: TokenProvider;
  readonly swapService: SwapService;
  readonly walletProvider: WalletProvider;
  
  // Agent settings
  readonly agentSettings: {
    swapTimeout: number;
    lockDuration: number;
    minTokenValueUsd: number;
    maxSlippage: number;
    defaultBaseToken: string;
  };
  
  // Messaging broker
  readonly messageBroker: any;
  
  // Utility methods
  withTransaction<T>(operation: string, executor: () => Promise<T>): Promise<T>;
}

/**
 * Response type for verification results
 */
export interface VerificationResult {
  success: boolean;
  token: string;
  amount: string;
  timestamp: number;
  senderAddress: string;
  error?: string;
}

/**
 * Type for swap route details
 */
export interface SwapRoute {
  inputMint: string;
  outputMint: string;
  isPumpFunToken: boolean;
  bestRoute: "jupiter" | "raydium" | "pumpfun";
}

/**
 * Type for swap execution results
 */
export interface SwapExecutionResult {
  signature: string;
  inputAmount: number;
  outputAmount: number;
  price: number;
}

/**
 * Extension of agent for memory subscription handling
 */
export interface IMemoryManager {
  getMemories(options: any): Promise<any[]>;
  createMemory(memory: any): Promise<void>;
}

/**
 * Type for transfer state
 */
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

/**
 * Type for error with message
 */
export interface ErrorWithMessage {
  message: string;
  name?: string;
} 