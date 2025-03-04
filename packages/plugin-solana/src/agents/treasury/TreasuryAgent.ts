// TreasuryAgent.ts

import {
    elizaLogger,
    stringToUuid,
    UUID,
    Memory,
    generateObject,
    ModelClass,
    composeContext,
    generateText,
    Content,
    Actor,
    Goal,
    State,
    ModelProviderName,
    Character,
    Provider,
    IAgentRuntime as CoreAgentRuntime,
    IMemoryManager,
    Action,
    HandlerCallback
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent.ts";
import {
    SwapRequest,
    ContentStatus,
    AgentTypes,
    AgentState,
    AgentCapability,
    AgentMessage,
    DistributedLock,
    IExtendedMemoryManager,
    IAgentRuntime,
    BaseContent,
    AgentType
} from "../../shared/types/base.ts";
import {
    DepositContent,
    TransferContent,
    TreasuryTransaction,
    WalletRegistration,
    TokenBalance,
    PendingDeposit,
    PendingTransaction
} from "../../shared/types/treasury.ts";
import { WalletProvider } from "../../providers/wallet.ts";
import { TokenProvider } from "../../providers/token.ts";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { StrategyExecutionRequest, StrategyExecutionResult } from "../../shared/types/strategy.ts";
import { SwapService } from "../../services/swapService.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { ProposalContent as VoteProposalContent } from "../../shared/types/vote.ts";
import { getMemoryRoom } from "../../shared/constants.ts";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import { withTransaction, createTransactionManager } from "../../shared/utils/withTransaction.ts";
import { getUserIdFromMessage, findUserIdByWalletAddress, normalizeUserId, getValidatedUserIdFromMessage } from "../../shared/utils/userUtils.ts";
import { v4 as uuidv4 } from 'uuid';
import * as bs58 from "bs58";
import BigNumber from "bignumber.js";
import { verifyAndRecordDeposit } from "../../utils/depositUtils.ts";
import { extractWalletAddress } from "../../utils/commandValidation.ts";
import { safeExtractMessageText } from "../../shared/utils.ts";
import { ANONYMOUS_USER_ID, ensureSystemUsers } from "../../shared/fixes/system-user.ts";
import { storeUserMessageWithDeduplication, CONVERSATION_ROOM_ID } from "../../shared/utils/messageUtils.ts";
import { MessageBroker } from "../../shared/MessageBroker.ts";
import * as path from "path";
import * as fs from "fs";

// Import handler modules
import * as registerHandler from "./registerHandler.ts";
import * as depositHandler from "./depositHandler.ts";
import * as swapHandler from "./swapHandler.ts";
import * as messageHandler from "./messageHandler.ts";
import * as transferHandler from "./transferHandler.ts";
import * as strategyHandler from "./strategyHandler.ts";
import * as proposalHandler from "./proposalHandler.ts";

// Add any missing imports
import { getWalletKey } from "../../keypairUtils.ts";
import { ProposalType } from "../../shared/types/proposal.ts";
import { ITreasuryAgentForHandlers } from "./types/handlerTypes.ts";
import { ITreasuryAgent } from "./messageHandlerTypes.ts";

// -------------------------
// Type definitions
// -------------------------

interface SwapRoute {
    inputMint: string;
    outputMint: string;
    isPumpFunToken: boolean;
    bestRoute: "jupiter" | "raydium" | "pumpfun";
}

interface SwapResult {
    signature: string;
    outputAmount: string;
    price: number;
}

export interface ExtendedStrategy {
    initialTakeProfit: number;
    secondTakeProfit: number;
    stopLoss: number;
    exitTimeframe: string;
    exitIndicator: string;
    initialSellPct?: number;
    secondSellPct?: number;
    useTA?: boolean;
}

export enum PendingSwapStatus {
    AWAITING_STRATEGY = "awaiting_strategy",
    CONFIRMED = "confirmed",
    CANCELLED = "cancelled",
}

export interface TradeMemory {
    type: "trade";
    text: string;
    status: "active" | "partial_exit" | "full_exit" | "stopped_out";
    inputToken: string;
    outputToken: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
    timestamp: number;
    strategy: ExtendedStrategy;
    partialSells?: Array<{
        timestamp: number;
        amount: number;
        price: number;
        reason?: string;
        signature?: string;
    }>;
    tokensRemaining?: number;
    [key: string]: any;
}

interface JupiterQuoteResponse {
    error?: string;
    outAmount?: string;
    routePlan?: any[];
    priceImpactPct?: number;
    outAmountWithSlippage?: string;
}

function isValidQuoteResponse(data: unknown): data is JupiterQuoteResponse {
    const response = data as JupiterQuoteResponse;
    return response && typeof response === 'object' && 
        (!response.error || typeof response.error === 'string') &&
        (!response.outAmount || typeof response.outAmount === 'string') &&
        (!response.priceImpactPct || typeof response.priceImpactPct === 'number') &&
        (!response.routePlan || Array.isArray(response.routePlan));
}

interface SwapError {
    error: string;
}

function isSwapError(error: unknown): error is SwapError {
    return typeof error === 'object' && error !== null && 'error' in error && typeof (error as SwapError).error === 'string';
}

interface ErrorWithMessage {
    message: string;
    name?: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
    return (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as Record<string, unknown>).message === 'string'
    );
}

function getErrorMessage(error: unknown): string {
    if (isErrorWithMessage(error)) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
}

interface TokenApiResponse {
    tokens: Array<{ address: string; symbol: string; }>;
}

function isTokenApiResponse(data: unknown): data is TokenApiResponse {
    return (
        typeof data === 'object' &&
        data !== null &&
        'tokens' in data &&
        Array.isArray((data as TokenApiResponse).tokens)
    );
}

interface SwapContext {
    swapService: SwapService;
    connection: Connection;
    keypair: Keypair;
}

interface SwapExecutionResult extends BaseContent {
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

interface GenerateObjectResult<T> {
    inputTokenCA?: string;
    outputTokenCA?: string;
    amount?: number;
    inputTokenSymbol?: string;
    outputTokenSymbol?: string;
    [key: string]: any;
}

interface ProposalInterpretation {
    details: ProposalDetails;
}

interface ProposalContent extends BaseContent {
    interpretation?: ProposalInterpretation;
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

interface TransferState extends State {
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
    [key: string]: any;  // Add index signature to match State
}

// Add missing ProposalDetails type
type ProposalDetails = {
    type: 'swap';
    inputToken: string;
    outputToken: string;
    amount: string;
} | {
    type: 'strategy';
} | {
    type: 'governance';
} | {
    type: 'parameter_change';
} | {
    type: 'other';
};

// Add missing interfaces
interface RegisterValidationResult {
    isValid: boolean;
    walletAddress: string;
    reason: string;
}

interface SwapDetails {
    type: 'swap';
    inputToken: string;
    outputToken: string;
    amount: string;
}

// Add type for structured error logging
interface ErrorLogObject {
    error: string;
    [key: string]: unknown;
}

// Update error logging helper
function formatErrorLog(error: unknown): ErrorLogObject {
    return {
        error: getErrorMessage(error)
    };
}

// Fix the RegisterState interface to make roomId required
interface RegisterState extends State {
    walletAddress: string;
    bio: string;
    lore: string;
    messageDirections: string;
    postDirections: string;
    roomId: UUID;
    userId?: UUID;
    agentId?: UUID;
    actors: string;
    actorsData?: Actor[];
    goals?: string;
    goalsData?: Goal[];
    recentMessages: string;
    recentMessagesData: Memory[];
    actionNames?: string;
}

interface StopLossConfig {
    percentage: number;
    price?: number;
    isTrailing?: boolean;
    trailingDistance?: number;
    highestPrice?: number;
}

// Extend the imported type
interface ExtendedStrategyExecutionRequest extends StrategyExecutionRequest {
    stopLoss?: StopLossConfig;
    strategyType?: "TRAILING_STOP" | "TAKE_PROFIT" | "STOP_LOSS";
}

// Add this interface near the top with other interfaces
interface VerifiedDepositContent extends BaseContent {
    type: "deposit_verified";
    fromAddress: string;
    amount: string;
    token: string;
    metadata?: {
        discordId?: string;
        [key: string]: unknown;
    };
}

interface TreasuryInterpretation {
    actionType: "register" | "deposit" | "verify" | "balance" | "unknown";
    // For registration
    walletAddress?: string;
    // For verification
    transactionSignature?: string;
    // Common fields
    confidence: number;
    reason?: string;
}

export class TreasuryAgent extends BaseAgent implements ITreasuryAgent {
    public walletProvider: WalletProvider;
    public tokenProvider: TokenProvider;
    public swapService: SwapService;
    public readonly agentSettings: {
        swapTimeout: number;
        lockDuration: number;
        minTokenValueUsd: number;
        maxSlippage: number;
        defaultBaseToken: string;
    };
    private pendingSwaps: Map<UUID, NodeJS.Timeout> = new Map();

    private readonly registerValidationTemplate = `
        You are validating a Solana wallet address registration command.
        The wallet address should be a base58-encoded string between 32-44 characters.

        Wallet address to validate: {{walletAddress}}

        Respond with a JSON object:
        {
            "isValid": boolean,
            "walletAddress": string,
            "reason": string
        }
    `;

    constructor(runtime: ExtendedAgentRuntime) {
        try {
            elizaLogger.info("Initializing TreasuryAgent constructor...");
            
            // Debug log environment variables
            elizaLogger.info("Environment variables state:", {
                SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
                SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
                BASE_TOKEN: process.env.BASE_TOKEN,
                NODE_ENV: process.env.NODE_ENV
            });
            
            super(runtime);
            
            // Initialize agent settings from environment variables or defaults
            this.agentSettings = {
                swapTimeout: parseInt(process.env.SWAP_TIMEOUT_MS || "600000"), // Default: 10 minutes
                lockDuration: parseInt(process.env.LOCK_DURATION_MS || "30000"), // Default: 30 seconds
                minTokenValueUsd: parseFloat(process.env.MIN_TOKEN_VALUE_USD || "0.1"), // Default: $0.10
                maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || "1.0"), // Default: 1%
                defaultBaseToken: process.env.BASE_TOKEN || "USDC" // Default: USDC
            };
            
            elizaLogger.info("TreasuryAgent constructor initialized successfully with settings:", this.agentSettings);
        } catch (error) {
            elizaLogger.error("Failed to initialize Treasury Agent constructor:", error);
            throw error;
        }
    }

    /**
     * Initialize actions asynchronously
     */
    private async initializeActions(): Promise<void> {
        // Load token info action
        try {
            // Use dynamic ESM import with destructuring to get the named export
            const { tokeninfo } = await import("../../actions/tokeninfo.ts");
            // Now we have the actual Action object
            this.runtime.registerAction(tokeninfo);
            elizaLogger.info("Successfully loaded tokeninfo action");
        } catch (error) {
            elizaLogger.warn("Could not load tokeninfo action:", error);
            if (error instanceof Error) {
                elizaLogger.warn("Error details:", {
                    message: error.message,
                    name: error.name,
                    stack: error.stack
                });
            }
        }
    }

    public override async initialize(): Promise<void> {
        try {
            elizaLogger.info("Initializing TreasuryAgent...");
            
            // Initialize base agent
            await super.initialize();
            
            // Ensure system users exist
            await ensureSystemUsers(this.runtime);
            
            // Initialize wallet provider
            if (!process.env.SOLANA_PUBLIC_KEY) {
                throw new Error("SOLANA_PUBLIC_KEY environment variable is required");
            }
            
            const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
            const walletPubkey = new PublicKey(process.env.SOLANA_PUBLIC_KEY);
            
            this.walletProvider = new WalletProvider(connection, walletPubkey);
            
            // Initialize token provider
            const SOL_MINT = "So11111111111111111111111111111111111111112";
            this.tokenProvider = new TokenProvider(SOL_MINT, this.walletProvider, this.runtime.cacheManager);
            
            // Initialize swap service
            this.swapService = new SwapService(this.runtime as ExtendedAgentRuntime);
            
            // Setup cross-process events
            this.setupCrossProcessEvents();
            
            // Setup swap tracking
            this.setupSwapTracking();
            
            // Initialize language model for general conversation
            try {
                const apiKey = this.runtime.getSetting("OPENAI_API_KEY");
                if (apiKey) {
                    elizaLogger.info("Initializing OpenAI language model for TreasuryAgent");
                    
                    // Create a simple language model interface that uses the generateText function
                    // @ts-ignore - Adding custom property to runtime for compatibility
                    this.runtime.languageModel = {
                        generateText: async (context, options = {}) => {
                            const response = await generateText({
                                runtime: this.runtime,
                                context,
                                modelClass: ModelClass.MEDIUM,
                                ...options
                            });
                            return response;
                        },
                        generateResponse: async (context, options = {}) => {
                            // @ts-ignore - Using custom property on runtime
                            return this.runtime.languageModel.generateText(context, options);
                        }
                    };
                    elizaLogger.info("OpenAI language model initialized successfully");
                } else {
                    elizaLogger.warn("No OpenAI API key found. General conversation responses will use fallback.");
                }
            } catch (error) {
                elizaLogger.error("Failed to initialize language model:", error);
                // Continue without the language model - fallback will be used
            }
            
            // Initialize actions
            await this.initializeActions();
            
            elizaLogger.info("TreasuryAgent initialized successfully");
        } catch (error) {
            elizaLogger.error("Error initializing TreasuryAgent:", error);
            throw error;
        }
    }

    private setupSwapTracking(): void {
        // No longer need to subscribe here since all subscriptions are handled in setupMemorySubscriptions
        elizaLogger.info("Swap tracking initialized");
    }

    protected async handleMemory(mem: Memory): Promise<void> {
        // Skip processing memories from this agent to avoid loops
        if (mem.agentId === this.getId()) {
            return;
        }

        const content = mem.content;
        if (!content) {
            return;
        }

        try {
            switch (content.type) {
                // Token Operations
                case "swap_request":
                    const keypair = await this.getKeyPair();
                    if (!keypair) throw new Error("Failed to get keypair");
                    const agentWithKeypair: ITreasuryAgentForHandlers = {
                        getKeyPair: () => keypair,
                        getRuntime: this.getRuntime.bind(this),
                        getAgentId: this.getAgentId.bind(this),
                        getAgentType: this.getAgentType.bind(this),
                        getConnection: this.getConnection.bind(this),
                        getSetting: this.getSetting.bind(this),
                        createMemoryPublic: this.createMemoryPublic.bind(this),
                        acquireDistributedLock: this.acquireDistributedLock.bind(this),
                        releaseDistributedLock: this.releaseDistributedLock.bind(this),
                        getTreasuryAddress: this.getTreasuryAddress.bind(this),
                        sendMessage: this.sendMessage.bind(this),
                        quickTokenValidation: this.quickTokenValidation.bind(this),
                        quickSecurityCheck: this.quickSecurityCheck.bind(this),
                        swapService: this.swapService,
                        walletProvider: this.walletProvider,
                        tokenProvider: this.tokenProvider,
                        agentSettings: this.agentSettings,
                        messageBroker: this.messageBroker,
                        withTransaction: async <T>(operation: string, executor: () => Promise<T>): Promise<T> => {
                            return withTransaction(createTransactionManager(this.runtime.messageManager), executor);
                        }
                    };
                    await swapHandler.handleSwapRequest(agentWithKeypair, content as SwapRequest);
                    break;
                    
                case "swap_execution_result":
                    // Handle results from swap execution
                    elizaLogger.info(`Received swap execution result: ${(content as any).success ? 'success' : 'failed'}`);
                    break;
                    
                // Deposit handling
                case "deposit_received":
                    await depositHandler.handleDeposit(this, content as DepositContent);
                    break;
                    
                case "pending_deposit":
                    // Track pending deposits
                    elizaLogger.info(`Tracking pending deposit: ${(content as any).txSignature || 'unknown'}`);
                    break;
                    
                case "deposit_verified":
                    // Process verified deposits
                    elizaLogger.info(`Processing verified deposit: ${(content as any).txSignature || 'unknown'}`);
                    break;
                    
                // Transfer handling
                case "transfer_requested":
                    await transferHandler.handleTransfer(this, mem);
                    break;
                    
                // Transaction handling
                case "transaction":
                case "treasury_transaction":
                case "transaction_completed":
                case "pending_transaction":
                case "transaction_status_changed":
                    // Consolidate all transaction type handling
                    elizaLogger.debug(`Transaction event received: ${content.type}`);
                    // We'll implement more detailed processing later
                    break;
                    
                // Proposal handling - support both legacy and new types
                case "proposal":
                case "proposal_created":
                    await proposalHandler.handleProposalEvent(this, content as any);
                    break;
                    
                case "proposal_passed":
                case "proposal_status_changed":
                    // Check if this is a passed proposal that needs execution
                    if ((content as any).status === "pending_execution" || 
                        content.type === "proposal_passed") {
                        await proposalHandler.handleProposalExecution(this, content as any);
                    } else {
                        elizaLogger.info(`Proposal status changed: ${(content as any).status || 'unknown'}`);
                    }
                    break;
                    
                case "proposal_executed":
                case "proposal_execution_result":
                    await proposalHandler.handleProposalExecuted(this, content as any);
                    break;
                    
                // Update registration handling to look for user messages with registration intent
                case "user_message":
                    // Check if this message has wallet registration intent
                    const metadata = content.metadata as Record<string, unknown>;
                    if (metadata?.hasWalletRegistrationIntent === true) {
                        elizaLogger.info("Processing user message with wallet registration intent", {
                            messageId: mem.id,
                            userId: mem.userId,
                            text: content.text?.substring(0, 100)
                        });
                        
                        // Convert to AgentMessage format for handleRegisterCommand
                        const now = Date.now();
                        const agentMessage: AgentMessage = {
                            type: "user_message",
                            content: {
                                id: mem.id,
                                agentId: this.getAgentId(),
                                type: "user_message",
                                text: content.text || "",
                                createdAt: now,
                                updatedAt: now,
                                status: "open",
                                metadata: {
                                    userId: mem.userId
                                }
                            },
                            from: this.getAgentType(),
                            to: this.getAgentType()
                        };
                        
                        await this.handleRegisterCommand(agentMessage);
                    }
                    break;
                    
                // Keep the wallet_registration case for actual registrations
                case "wallet_registration":
                    // Only process if this is an actual registration record (has walletAddress)
                    if (content.walletAddress) {
                        elizaLogger.debug("Processing wallet registration record", {
                            walletAddress: content.walletAddress,
                            status: content.status,
                            userId: content.userId
                        });
                    }
                    break;
                    
                // Response handling
                case "deposit_response":
                case "register_response":
                case "verify_response":
                case "transfer_response":
                case "balance_response":
                    // These are outgoing responses, typically don't need handling
                    elizaLogger.debug(`Response event: ${content.type}`);
                    break;
                    
                // Strategy handling
                case "strategy_execution_request":
                    await strategyHandler.handleStrategyExecution(this, content as StrategyExecutionRequest);
                    break;
                    
                case "strategy_status_changed":
                    // Track strategy status changes
                    elizaLogger.info(`Strategy status changed: ${(content as any).status || 'unknown'}`);
                    break;
                    
                case "strategy_execution_result":
                    // Process strategy execution results
                    elizaLogger.info(`Strategy execution result: ${(content as any).success ? 'success' : 'failed'}`);
                    break;
                    
                // Message handling - only process direct commands and treasury-related patterns
                case "message":
                    // Safely access text property
                    let msgText = "";
                    if (content && typeof content === 'object' && 'text' in content && 
                        typeof content.text === 'string') {
                        msgText = content.text.trim();
                    }
                    
                    // Process the message through the message handler
                    const { messageHandler } = await import("./messageHandler.ts");
                    await messageHandler.handleMessage(this, mem as unknown as AgentMessage);
                    break;
                    
                // Handle agent responses
                case "agent_response":
                    // No need to process our own responses again, just ensure they're stored
                    elizaLogger.debug("Received agent response memory", {
                        id: mem.id,
                        text: content.text?.substring(0, 50)
                    });
                    break;
                    
                default:
                    // Handle any other memory types
                    elizaLogger.debug(`Unhandled memory type in TreasuryAgent: ${content.type}`);
            }
        } catch (error) {
            elizaLogger.error("Error handling memory in TreasuryAgent:", error);
        }
    }

    public async validateAction(content: BaseContent): Promise<boolean> {
        try {
            // Convert BaseContent to AgentMessage format
            const message: AgentMessage = {
                content,
                type: content.type || "message",
                from: (content.userId || "TREASURY") as AgentType
            };

            // Call handleMessage from messageHandler instance
            const { messageHandler } = await import("./messageHandler.ts");
            await messageHandler.handleMessage(this, message);
            elizaLogger.info("Successfully handled message via validateAction");
            return true;
        } catch (error) {
            elizaLogger.error("Error in validateAction:", error);
            return false;
        }
    }

    public async handleBalanceCheck(message: AgentMessage): Promise<void> {
        try {
            // Get the wallet address for the treasury
            const treasuryAddress = await this.walletProvider.getWalletAddress();
            
            // Get the balance for the treasury wallet
            const portfolio = await this.walletProvider.fetchPortfolioValue(this.runtime);
            const totalBalance = portfolio.totalSol || "0";
            
            // Format the balance response
            const balanceText = `Current treasury balance: ${totalBalance} SOL`;
            
            // Send the response
            await this.sendMessage({
                type: "balance_response",
                content: {
                    id: stringToUuid(`balance-${Date.now()}`),
                    text: balanceText,
                    type: "balance_response",
                    status: "executed" as ContentStatus,
                    agentId: this.getAgentId(),
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.getAgentType(),
                to: "ALL"
            });
        } catch (error) {
            elizaLogger.error("Error in balance check:", error);
            
            // Send error response
            await this.sendMessage({
                type: "error_response",
                content: {
                    id: stringToUuid(`balance-error-${Date.now()}`),
                    text: "Failed to retrieve treasury balance. Please try again later.",
                    type: "error_response",
                    status: "failed" as ContentStatus,
                    agentId: this.getAgentId(),
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: this.getAgentType(),
                to: "ALL"
            });
        }
    }

    // Alias handleBalanceCheck as handleBalanceCommand for interface compatibility
    public async handleBalanceCommand(message: AgentMessage): Promise<void> {
        await this.handleBalanceCheck(message);
    }

    // Add required implementations for BaseAgent abstract methods
    public async executeAction(content: BaseContent): Promise<boolean> {
        // Implement action execution logic
        return true; // Simple implementation for now
    }

    protected loadActions(): void {
        // Add a NONE action to handle casual conversation
        const noneAction: Action = {
            name: "NONE",
            similes: ["general_conversation"],
            description: "Represents no action needed; used for general conversation responses",
            examples: [],
            validate: async (runtime: IAgentRuntime, message: Memory) => {
                const text = message.content?.text?.toLowerCase() || "";
                
                elizaLogger.debug("Validating NONE action for message:", {
                    textSnippet: text.substring(0, 50) + (text.length > 50 ? "..." : ""),
                    messageId: message.id
                });
                
                // This action should only be chosen as a last resort when no other action matches
                // First check that no specific treasury commands are present
                if (text.startsWith('!') || 
                    /^(?:how\s+(?:do|can)\s+I\s+deposit|I\s+want\s+to\s+deposit|deposit\s+instructions)\b/i.test(text) ||
                    /^(?:what(?:'s| is)(?: the)? (?:treasury )?balance|show(?: me)?(?: the)? (?:treasury )?balance|check(?: the)? (?:treasury )?balance)\b/i.test(text)) {
                    elizaLogger.debug("NONE action not applicable - message matches specific command pattern");
                    return false;
                }
                
                // Default to true for all other messages - these will get handled by handleGeneralConversation
                elizaLogger.debug("NONE action applicable - will handle as general conversation");
                return true;
            },
            handler: async (runtime: IAgentRuntime, message: Memory) => {
                elizaLogger.info("Executing NONE action handler for general conversation", {
                    messageId: message.id,
                    textSnippet: message.content?.text?.substring(0, 50) + (message.content?.text?.length > 50 ? "..." : "") || "no text"
                });
                
                // Explicitly call handleMessage from messageHandler
                try {
                    const { messageHandler } = await import("./messageHandler.ts");
                    await messageHandler.handleMessage(this, message as unknown as AgentMessage);
                    elizaLogger.info("Successfully handled general conversation via NONE action");
                    return true;
                } catch (error) {
                    elizaLogger.error("Error in messageHandler.handleMessage:", error);
                    return false;
                }
            }
        };
        
        this.runtime.registerAction(noneAction);

        // Register agent capabilities
        this.registerCapability({
            name: "wallet_management",
            description: "Manage user wallet registrations and balances",
            requiredPermissions: ["manage_wallets"],
            actions: ["register", "verify", "balance"]
        });

        this.registerCapability({
            name: "swap_execution",
            description: "Execute token swaps",
            requiredPermissions: ["execute_swaps"],
            actions: ["swap"]
        });

        this.registerCapability({
            name: "treasury_monitoring",
            description: "Monitor treasury activities",
            requiredPermissions: ["view_treasury"],
            actions: ["balance", "history"]
        });

        this.registerCapability({
            name: "balance_tracking",
            description: "Track token balances",
            requiredPermissions: ["view_balances"],
            actions: ["balance"]
        });

        // Register Wallet Action
        const registerAction: Action = {
            name: "register",
            description: "Register a Solana wallet with the treasury",
            similes: ["register_wallet", "register_solana_wallet"],
            examples: [
                [
                    { 
                        user: "user",
                        content: { 
                            text: "!register <wallet_address>" 
                        } 
                    },
                    { 
                        user: "agent",
                        content: { 
                            text: "Wallet registered successfully!" 
                        } 
                    }
                ]
            ],
            validate: async (runtime: IAgentRuntime, message: Memory) => {
                const text = message.content?.text?.toLowerCase() || "";
                return text.startsWith('!register');
            },
            handler: async (runtime: IAgentRuntime, message: Memory, state: any, options: any, callback?: HandlerCallback): Promise<boolean> => {
                try {
                    const now = Date.now();
                    const baseContent: BaseContent = {
                        id: message.id || stringToUuid(`register-${now}`),
                        type: "register_command",
                        text: message.content?.text || "",
                        status: "open" as ContentStatus,
                        agentId: this.getAgentId(),
                        createdAt: now,
                        updatedAt: now
                    };

                    const agentMessage: AgentMessage = {
                        type: "register_command",
                        content: baseContent,
                        from: (message.userId || "ANONYMOUS") as AgentType,
                        to: this.getAgentId() as AgentType
                    };

                    await registerHandler.handleRegisterCommand(this, agentMessage, async (response: BaseContent) => {
                        if (callback && response.text) {
                            await callback({
                                text: response.text,
                                content: {
                                    type: "register_response",
                                    id: stringToUuid(`response-${Date.now()}`),
                                    text: response.text,
                                    status: "executed",
                                    agentId: this.getAgentId(),
                                    createdAt: Date.now(),
                                    updatedAt: Date.now()
                                } as BaseContent
                            });
                        }
                    });
                    return true;
                } catch (error) {
                    elizaLogger.error("Error in registerAction:", error);
                    if (callback) {
                        await callback({
                            text: `Error registering wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            content: {
                                type: "register_response",
                                id: stringToUuid(`error-${Date.now()}`),
                                text: `Error registering wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
                                status: "failed",
                                agentId: this.getAgentId(),
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            } as BaseContent
                        });
                    }
                    return false;
                }
            }
        };

        // Register deposit action
        const depositAction: Action = {
            name: "deposit",
            similes: ["deposit_instructions", "how_to_deposit"],
            description: "Get instructions for depositing funds to the treasury",
            examples: [
                [
                    { 
                        user: "user",
                        content: { 
                            text: "!deposit" 
                        } 
                    },
                    { 
                        user: "agent",
                        content: { 
                            text: "Get deposit instructions" 
                        } 
                    }
                ]
            ],
            validate: async (runtime: IAgentRuntime, message: Memory) => {
                const text = message.content?.text?.toLowerCase() || "";
                
                // Only validate for explicit deposit commands or very specific deposit phrases
                return text.startsWith('!deposit') || 
                       /^(?:how\s+(?:do|can)\s+I\s+deposit|I\s+want\s+to\s+deposit|deposit\s+instructions)\b/i.test(text);
            },
            handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: any, callback?: (result: any) => void): Promise<boolean> => {
                try {
                    await this.handleDepositInstructions(message as unknown as AgentMessage);
                    return true;
                } catch (error) {
                    elizaLogger.error("Error in deposit action handler:", error);
                    
                    if (callback) {
                        callback({
                            id: stringToUuid(`deposit-error-${Date.now()}`),
                            type: "deposit_response",
                            text: `Error providing deposit instructions: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            status: "failed" as ContentStatus,
                            agentId: this.getAgentId(),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });
                    }
                    
                    return false;
                }
            }
        };

        // Register verification action
        const verifyAction: Action = {
            name: "verify",
            similes: ["verify_transaction", "verify_deposit"],
            description: "Verify a deposit transaction",
            examples: [
                [
                    { 
                        user: "user",
                        content: { 
                            text: "!verify <transaction_signature>" 
                        } 
                    },
                    { 
                        user: "agent",
                        content: { 
                            text: "Verify a deposit transaction" 
                        } 
                    }
                ]
            ],
            validate: async (runtime: IAgentRuntime, message: Memory) => {
                const text = message.content?.text?.toLowerCase() || "";
                
                // Only validate for explicit verify commands
                return text.startsWith('!verify');
            },
            handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: any, callback?: (result: any) => void): Promise<boolean> => {
                try {
                    await this.handleVerification(message as unknown as AgentMessage);
                    return true;
                } catch (error) {
                    elizaLogger.error("Error in verify action handler:", error);
                    
                    if (callback) {
                        callback({
                            id: stringToUuid(`verify-error-${Date.now()}`),
                            type: "verify_response",
                            text: `Error verifying deposit: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            status: "failed" as ContentStatus,
                            agentId: this.getAgentId(),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });
                    }
                    
                    return false;
                }
            }
        };

        // Add balance action
        const balanceAction: Action = {
            name: "balance",
            similes: ["treasury_balance", "check_treasury_balance"],
            description: "Check the treasury balance",
            examples: [
                [
                    { 
                        user: "user",
                        content: { 
                            text: "!balance" 
                        } 
                    },
                    { 
                        user: "agent",
                        content: { 
                            text: "Check the treasury balance" 
                        } 
                    }
                ]
            ],
            validate: async (runtime: IAgentRuntime, message: Memory) => {
                const text = message.content?.text?.toLowerCase() || "";
                
                // Only validate for explicit balance commands or very specific balance phrases
                return text.startsWith('!balance') || 
                       /^(?:what(?:'s| is)(?: the)? (?:treasury )?balance|show(?: me)?(?: the)? (?:treasury )?balance|check(?: the)? (?:treasury )?balance)\b/i.test(text);
            },
            handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: any, callback?: (result: any) => void): Promise<boolean> => {
                try {
                    await this.handleBalanceCheck(message as unknown as AgentMessage);
                    
                    if (callback) {
                        callback({
                            id: stringToUuid(`balance-${Date.now()}`),
                            type: "balance_response",
                            text: "Balance check completed successfully",
                            status: "executed" as ContentStatus,
                            agentId: this.getAgentId(),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });
                    }
                    
                    return true;
                } catch (error) {
                    elizaLogger.error("Error in balance action handler:", error);
                    
                    if (callback) {
                        callback({
                            id: stringToUuid(`balance-error-${Date.now()}`),
                            type: "balance_response",
                            text: `Error retrieving treasury balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            status: "failed" as ContentStatus,
                            agentId: this.getAgentId(),
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        });
                    }
                    
                    return false;
                }
            }
        };

        // Register all actions
        this.runtime.registerAction(registerAction);
        this.runtime.registerAction(depositAction);
        this.runtime.registerAction(verifyAction);
        this.runtime.registerAction(balanceAction);
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // Setup cross-process event handlers
        // This is a placeholder implementation
    }

    protected override async handleMessage(message: AgentMessage): Promise<void> {
        try {
            // The message handler will store the user message, so we don't need to do it here
            // to avoid duplication
            
            // Process the message through the message handler
            const { messageHandler } = await import("./messageHandler.ts");
            await messageHandler.handleMessage(this, message);
        } catch (error) {
            elizaLogger.error("Error in handleMessage:", error);
            
            // Attempt to send a fallback response if message handling fails
            try {
                await this.sendMessage({
                    type: "error_response",
                    content: {
                        type: "error_response",
                        id: stringToUuid(`error-${Date.now()}`),
                        text: "I encountered an error processing your message. Please try again or use a specific command like !register, !deposit, !balance, or !verify.",
                        status: "failed" as ContentStatus,
                        agentId: this.getAgentId(),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    from: this.getAgentType(),
                    to: "ALL"
                });
            } catch (sendError) {
                elizaLogger.error("Failed to send error response:", sendError);
            }
        }
    }

    // Add getters needed by handler modules
    public getRuntime(): ExtendedAgentRuntime {
        return this.runtime as ExtendedAgentRuntime;
    }

    public getAgentId(): UUID {
        return this.runtime.agentId;
    }

    public getAgentType(): AgentType {
        return this.runtime.agentType as AgentType;
    }

    /**
     * Get the Solana connection
     */
    public getConnection(): Connection | null {
        try {
            const rpcUrl = this.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
            return new Connection(rpcUrl);
        } catch (error) {
            elizaLogger.error("Error creating Solana connection:", error);
            return null;
        }
    }

    /**
     * Get the treasury wallet address
     */
    public getTreasuryAddress(): string | null {
        try {
            const publicKeyStr = this.getSetting("SOLANA_PUBLIC_KEY");
            if (!publicKeyStr) {
                return null;
            }
            return publicKeyStr;
        } catch (error) {
            elizaLogger.error("Error getting treasury address:", error);
            return null;
        }
    }

    /**
     * Get the treasury keypair
     */
    public async getKeyPair(): Promise<Keypair | null> {
        try {
            const result = await getWalletKey(this.runtime, true);
            return result.keypair;
        } catch (error) {
            elizaLogger.error("Error getting treasury keypair:", error);
            return null;
        }
    }

    public getSetting(key: string): string | undefined {
        return process.env[key];
    }

    // Add public wrappers for protected methods to be used by handlers
    public async createMemoryPublic(content: BaseContent): Promise<void> {
        return this.createMemory(content);
    }

    // Update handler methods to use our handler modules
    // These methods will now delegate to the appropriate handler modules

    public async handleRegisterCommand(message: AgentMessage): Promise<void> {
        try {
            elizaLogger.info("Handling register command", { 
                messageText: message.content.text,
                userId: message.from
            });

            // Process the registration via the registerHandler module's function
            try {
                await registerHandler.handleRegisterCommand(this, message, async (response: BaseContent) => {
                    if (response && response.text) {
                        await this.sendMessage({
                            type: "register_response",
                            content: {
                                type: "register_response",
                                id: stringToUuid(`register-response-${Date.now()}`),
                                text: response.text,
                                status: "executed" as ContentStatus,
                                agentId: this.getAgentId(),
                                createdAt: Date.now(),
                                updatedAt: Date.now()
                            } as BaseContent,
                            from: this.getAgentType(),
                            to: "ALL"
                        });
                    }
                });
            } catch (error) {
                elizaLogger.error("Error in wallet registration:", error);
                await this.sendMessage({
                    type: "register_response",
                    content: {
                        type: "register_response",
                        id: stringToUuid(`register-error-${Date.now()}`),
                        text: `Failed to register wallet: ${error instanceof Error ? error.message : 'Unknown error'}`,
                        status: "failed" as ContentStatus,
                        agentId: this.getAgentId(),
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    } as BaseContent,
                    from: this.getAgentType(),
                    to: "ALL"
                });
            }
        } catch (error) {
            elizaLogger.error("Error in handleRegisterCommand:", error);
        }
    }

    public async handleDepositInstructions(message: AgentMessage): Promise<void> {
        return depositHandler.handleDepositInstructions(this, message);
    }

    public async handleSwapRequest(request: SwapRequest): Promise<{ signature: string; price: number }> {
        const keypair = await this.getKeyPair();
        if (!keypair) throw new Error("Failed to get keypair");
        const agentWithKeypair: ITreasuryAgentForHandlers = {
            getKeyPair: () => keypair,
            getRuntime: this.getRuntime.bind(this),
            getAgentId: this.getAgentId.bind(this),
            getAgentType: this.getAgentType.bind(this),
            getConnection: this.getConnection.bind(this),
            getSetting: this.getSetting.bind(this),
            createMemoryPublic: this.createMemoryPublic.bind(this),
            acquireDistributedLock: this.acquireDistributedLock.bind(this),
            releaseDistributedLock: this.releaseDistributedLock.bind(this),
            getTreasuryAddress: this.getTreasuryAddress.bind(this),
            sendMessage: this.sendMessage.bind(this),
            quickTokenValidation: this.quickTokenValidation.bind(this),
            quickSecurityCheck: this.quickSecurityCheck.bind(this),
            swapService: this.swapService,
            walletProvider: this.walletProvider,
            tokenProvider: this.tokenProvider,
            agentSettings: this.agentSettings,
            messageBroker: this.messageBroker,
            withTransaction: async <T>(operation: string, executor: () => Promise<T>): Promise<T> => {
                return withTransaction(createTransactionManager(this.runtime.messageManager), executor);
            }
        };
        return swapHandler.handleSwapRequest(agentWithKeypair, request);
    }

    public async handleVerification(content: DepositContent | AgentMessage): Promise<void> {
        return depositHandler.handleVerification(this, content);
    }

    public async getPendingDeposit(txSignature: string): Promise<PendingDeposit | null> {
        return depositHandler.getPendingDeposit(this, txSignature);
    }

    // Make some methods public specifically for handler modules
    public async quickTokenValidation(tokenAddress: string): Promise<boolean> {
        // Implement token validation logic here
        return true; // Simplified for now
    }

    public async quickSecurityCheck(tokenCA: string): Promise<boolean> {
        // Implement security check logic here
        return true; // Simplified for now
    }

    // Add remaining required implementations from BaseAgent
    protected async getUserProfile(userId: UUID): Promise<{ reputation?: number; role?: string; } | null> {
        // Simplified implementation - could be expanded to fetch from a user profile service
        return {
            reputation: 0,
            role: "user"
        };
    }

    protected async executeWithValidation<T extends Record<string, unknown>, R>(
        operation: string,
        params: T,
        executor: (params: T) => Promise<R>
    ): Promise<R> {
        try {
            // Simplified implementation - could be expanded with more validation
            return await executor(params);
        } catch (error) {
            elizaLogger.error(`Error in ${operation}:`, error);
            throw error;
        }
    }

    /**
     * Acquire a distributed lock
     */
    public async acquireDistributedLock(key: string, timeoutMs: number = 30000): Promise<DistributedLock | null> {
        try {
            const now = Date.now();
            const expiresAt = now + timeoutMs;
            const lockId = stringToUuid(`lock-${key}-${now}`);

            // Try to insert the lock directly as active
            await this.runtime.messageManager.createMemory({
                id: lockId,
                content: {
                    type: "distributed_lock",
                    key,
                    holder: this.runtime.agentId,
                    expiresAt,
                    lockId,
                    version: 1,
                    lastRenewalAt: now,
                    renewalCount: 0,
                    lockState: 'active',
                    acquiredAt: now,
                    text: `Lock ${key} acquired by ${this.runtime.agentId}`,
                    agentId: this.runtime.agentId,
                    createdAt: now,
                    updatedAt: now,
                    status: "executed"
                },
                roomId: CONVERSATION_ROOM_ID,
                userId: stringToUuid(this.runtime.agentId),
                agentId: this.runtime.agentId,
                unique: true
            });

            // If we get here, we successfully acquired the lock
            return {
                key,
                holder: this.runtime.agentId,
                expiresAt,
                lockId,
                version: 1
            };
        } catch (error) {
            if (error.message?.includes('unique constraint')) {
                // Lock already exists and is active
                return null;
            }
            throw error;
        }
    }

    /**
     * Release a distributed lock
     */
    public async releaseDistributedLock(lock: DistributedLock): Promise<void> {
        try {
            // First verify we still hold the lock
            const currentLock = await this.runtime.messageManager.getMemoryWithLock(
                stringToUuid(`lock-${lock.key}-${lock.lockId}`)
            );

            if (!currentLock) {
                return; // Lock already released or expired
            }

            const content = currentLock.content as any;
            if (content.holder !== this.runtime.agentId || 
                content.lockState !== 'active' || 
                content.expiresAt <= Date.now()) {
                return; // We don't own the lock anymore
            }

            // Remove the lock if we still own it
            await this.runtime.messageManager.removeMemory(currentLock.id);
        } catch (error) {
            elizaLogger.error(`Error releasing lock for ${lock.key}:`, error);
            throw error;
        }
    }

    /**
     * Store user message in memory with deduplication
     * This implementation prevents storing the same message multiple times by using
     * our centralized message utilities.
     */
    public async storeUserMessage(message: AgentMessage): Promise<void> {
        try {
            // Use the centralized message storage utility to handle deduplication
            const messageId = await storeUserMessageWithDeduplication(
                this.runtime,
                message,
                this.getAgentId()
            );
            
            if (messageId) {
                elizaLogger.debug("Message stored or deduplicated successfully", { messageId });
            } else {
                elizaLogger.warn("Failed to store user message", { 
                    messageId: message.content?.id || "unknown"
                });
            }
        } catch (error) {
            elizaLogger.error("Error in storeUserMessage", { 
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                messageId: message.content?.id || "unknown"
            });
        }
    }

    /**
     * Run diagnostics on the memory system to ensure it's working correctly
     */
    private async runMemoryDiagnostics(): Promise<void> {
        try {
            elizaLogger.info("Running memory system diagnostics...");
            
            // Check if memory manager is available
            if (!this.runtime.messageManager) {
                elizaLogger.error("Memory manager is not available!");
                return;
            }
            
            // Log memory manager methods
            elizaLogger.debug("Memory manager methods:", {
                hasCreateMemory: typeof this.runtime.messageManager.createMemory === 'function',
                hasGetMemoriesByRoomIds: typeof this.runtime.messageManager.getMemoriesByRoomIds === 'function',
                hasSearchMemoriesByEmbedding: typeof this.runtime.messageManager.searchMemoriesByEmbedding === 'function',
                hasGetMemory: typeof this.runtime.messageManager.getMemory === 'function',
                hasRemoveMemory: typeof this.runtime.messageManager.removeMemory === 'function'
            });
            
            // Test creating and retrieving a memory
            const testId = stringToUuid(`test-memory-${Date.now()}`);
            // Use the consistent conversation room ID
            const roomId = CONVERSATION_ROOM_ID;
            
            elizaLogger.info("Creating test memory...");
            
            try {
                await this.runtime.messageManager.createMemory({
                    id: testId,
                    content: {
                        id: testId,
                        type: "diagnostic_test",
                        text: "This is a diagnostic test memory",
                        status: "completed" as ContentStatus,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    },
                    roomId: roomId,
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId
                });
                
                elizaLogger.info("Test memory created successfully");
                
                // Try to retrieve the test memory
                const memories = await this.runtime.messageManager.getMemoriesByRoomIds({
                    roomIds: [roomId],
                    limit: 10
                });
                
                const testMemory = memories.find(memory => memory.id === testId);
                
                if (testMemory) {
                    elizaLogger.info("Test memory retrieved successfully");
                } else {
                    elizaLogger.warn("Test memory not found in retrieved memories", {
                        retrievedCount: memories.length,
                        roomId: roomId
                    });
                }
                
                // Clean up test memory
                await this.runtime.messageManager.removeMemory(testId);
                elizaLogger.info("Test memory removed successfully");
                
            } catch (error) {
                elizaLogger.error("Error during memory diagnostics:", error);
            }
            
            elizaLogger.info("Memory system diagnostics completed");
        } catch (error) {
            elizaLogger.error("Failed to run memory diagnostics:", error);
        }
    }
}