import {
    elizaLogger,
    stringToUuid,
    UUID,
    Memory,
    State,
    Content
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent";
import {
    AgentMessage,
    BaseContent,
    SwapRequest,
    ContentStatus,
    AgentType,
    AgentTypes,
    AgentState,
    AgentCapability,
    CharacterName,
    DAOEventType,
    DAOEvent,
    Transaction,
    MemoryMetadata,
    SwapDetails
} from "../../shared/types/base";
import { ProposalContent } from "../../shared/types/proposal";
import {
    DepositContent,
    TransferContent,
    TreasuryTransaction,
    WalletRegistration,
    TokenBalance,
    PendingDeposit,
    PendingTransaction
} from "../../shared/types/treasury";
import { WalletProvider } from "../../providers/wallet";
import { TokenProvider } from "../../providers/token";
import { Connection, PublicKey } from "@solana/web3.js";
import { StrategyExecutionRequest, StrategyExecutionResult } from "../../shared/types/strategy";
import { SwapService } from "../../services/swapService";
import { ROOM_IDS } from "../../shared/constants";
import { IAgentRuntime as SolanaAgentRuntime } from "../../shared/types/base";

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

// Add utility functions
function generateShortId(): string {
    return Math.random().toString(36).substring(2, 15);
}

function shortIdToUuid(shortId: string): UUID {
    return stringToUuid(`tx-${shortId}`);
}

export class TreasuryAgent extends BaseAgent {
    private walletProvider: WalletProvider;
    private tokenProvider: TokenProvider;
    private swapService: SwapService;
    private pendingSwaps: Map<UUID, NodeJS.Timeout> = new Map();
    private readonly SWAP_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    constructor(runtime: SolanaAgentRuntime) {
        super(runtime);
        
        // Initialize providers
        const connection = new Connection(
            this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        const walletPubkey = new PublicKey(this.id);
        this.walletProvider = new WalletProvider(connection, walletPubkey);
        this.tokenProvider = new TokenProvider(
            "So11111111111111111111111111111111111111112", // SOL mint address
            this.walletProvider,
            this.runtime.cacheManager
        );
        this.swapService = new SwapService(this.runtime);

        this.setupSwapTracking();
    }

    private setupSwapTracking(): void {
        // Subscribe to swap execution results
        this.subscribeToMemory("swap_execution_result", async (memory) => {
            const content = memory.content as SwapExecutionResult;
            if (!content.swapId) return;

            // Clear any pending timeout
            const timeout = this.pendingSwaps.get(content.swapId);
            if (timeout) {
                clearTimeout(timeout);
                this.pendingSwaps.delete(content.swapId);
            }

            // Update proposal with swap result
            await this.handleSwapResult(content);
        });

        // Core memory subscriptions
        this.subscribeToMemory("swap_request", async (memory) => {
            const content = memory.content as SwapRequest;
            await this.handleSwapRequest(content);
        });

        this.subscribeToMemory("proposal_passed", async (memory) => {
            const content = memory.content as ProposalContent;
            await this.handleProposalExecution(content);
        });

        this.subscribeToMemory("strategy_triggered", async (memory) => {
            const content = memory.content as StrategyExecutionRequest;
            await this.handleStrategyExecution(content);
        });

        this.subscribeToMemory("deposit_received", async (memory) => {
            const content = memory.content as DepositContent;
            await this.handleDeposit(content);
        });

        this.subscribeToMemory("transfer_requested", async (memory) => {
            const content = memory.content as TransferContent;
            await this.handleTransfer(content);
        });

        this.subscribeToMemory("transaction_status_changed", async (memory) => {
            const content = memory.content as TreasuryTransaction;
            await this.handleTransaction(content);
        });
    }

    private async handleSwapResult(result: SwapExecutionResult): Promise<void> {
        try {
            // Create swap result memory
            await this.createMemory({
                type: "swap_completed",
                id: stringToUuid(`swap-result-${result.swapId}`),
                text: result.success 
                    ? `Swap completed: ${result.inputAmount} ${result.inputToken} -> ${result.outputAmount} ${result.outputToken}`
                    : `Swap failed: ${result.inputAmount} ${result.inputToken} -> ${result.outputToken}`,
                status: result.success ? "executed" : "failed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                metadata: {
                    swapId: result.swapId,
                    proposalId: result.proposalId,
                    success: result.success,
                    error: result.error,
                    executedBy: result.executedBy,
                    timestamp: result.timestamp,
                    inputToken: result.inputToken,
                    outputToken: result.outputToken,
                    inputAmount: result.inputAmount,
                    outputAmount: result.outputAmount
                }
            });

            // Create proposal execution result
            if (result.proposalId) {
                await this.createMemory({
                    type: "proposal_execution_result",
                    id: stringToUuid(`proposal-exec-${result.proposalId}`),
                    text: result.success 
                        ? `Proposal execution completed: Swap of ${result.inputAmount} ${result.inputToken}`
                        : `Proposal execution failed: ${result.error}`,
                    status: result.success ? "executed" : "failed",
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        proposalId: result.proposalId,
                        success: result.success,
                        error: result.error,
                        executedBy: this.runtime.agentId,
                        timestamp: result.timestamp
                    }
                });
            }

            elizaLogger.info(`Processed swap result for ${result.swapId}`, {
                success: result.success,
                error: result.error,
                proposalId: result.proposalId
            });
        } catch (error) {
            elizaLogger.error(`Error handling swap result for ${result.swapId}:`, error);
        }
    }

    protected async handleMemory(memory: Memory): Promise<void> {
        const content = memory.content;
        
        if (this.isSwapRequest(content)) {
            await this.handleSwapRequest(content);
        } else if (this.isDepositContent(content)) {
            await this.handleDeposit(content);
        } else if (this.isTransferContent(content)) {
            await this.handleTransfer(content);
        } else if (this.isStrategyWithSwap(content)) {
            await this.handleStrategyExecution(content);
        } else if (this.isProposalContent(content)) {
            await this.handleProposalExecution(content);
        }
    }

    protected loadActions(): void {
        this.registerCapability({
            name: "wallet_management",
            description: "Manage user wallet registrations and balances",
            requiredPermissions: ["manage_wallets"],
            actions: ["register", "verify", "balance"]
        });

        this.registerCapability({
            name: "transaction_management",
            description: "Handle deposits and transfers",
            requiredPermissions: ["manage_transactions"],
            actions: ["deposit", "transfer", "verify"]
        });
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        this.messageBroker.on("transaction_executed", async (event) => {
            if (this.isValidBaseContent(event)) {
                const shortId = generateShortId();
                const transactionEvent: ProposalContent = {
                    type: "proposal",
                    id: shortIdToUuid(shortId),
                    shortId,
                    title: `Transaction ${event.id} executed`,
                    description: event.text || `Transaction executed`,
                    text: event.text || `Transaction executed`,
                    proposer: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    status: "executed",
                    yes: [],
                    no: [],
                    deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours from now
                    voteStats: {
                        total: 0,
                        yes: 0,
                        no: 0,
                        totalVotingPower: 0,
                        totalYesPower: 0,
                        totalNoPower: 0,
                        yesPowerPercentage: 0,
                        quorumReached: false,
                        minimumYesVotesReached: false,
                        minimumPercentageReached: false
                    },
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        tags: ["transaction", "executed"],
                        priority: "high"
                    }
                };
                await this.createMemory(transactionEvent);
            }
        });
    }

    private isValidBaseContent(content: any): content is BaseContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            'id' in content &&
            'status' in content;
    }

    private isProposalWithSwap(content: ProposalContent): boolean {
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

    public override async shutdown(): Promise<void> {
        // Clear all swap timeouts
        for (const timeout of this.pendingSwaps.values()) {
            clearTimeout(timeout);
        }
        this.pendingSwaps.clear();
        
        await super.shutdown();
    }

    private isSwapRequest(content: any): content is SwapRequest {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'swap_request' &&
            'fromToken' in content &&
            'toToken' in content &&
            'amount' in content;
    }

    private isDepositContent(content: any): content is DepositContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'deposit_received' &&
            'token' in content &&
            'amount' in content;
    }

    private isTransferContent(content: any): content is TransferContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'transfer' &&
            'fromToken' in content &&
            'toToken' in content &&
            'amount' in content;
    }

    private isStrategyWithSwap(content: any): content is StrategyExecutionRequest {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'strategy_execution_request' &&
            'strategyId' in content &&
            'token' in content &&
            'amount' in content;
    }

    private isProposalContent(content: any): content is ProposalContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'proposal' &&
            'id' in content &&
            'title' in content &&
            'description' in content &&
            'proposer' in content &&
            'interpretation' in content;
    }

    private async getRegisteredWallet(userId: UUID): Promise<WalletRegistration | null> {
        const registrations = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.DAO,
            count: 1
        });
        const registration = registrations.find(mem => 
            mem.content.type === "wallet_registration" &&
            mem.content.userId === userId &&
            mem.content.status === "executed"
        );
        return registration?.content as WalletRegistration || null;
    }

    private async getPendingDeposit(txSignature: string): Promise<PendingDeposit | null> {
        const deposits = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.TREASURY,
            count: 1
        });
        const deposit = deposits.find(mem =>
            mem.content.type === "deposit_received" &&
            mem.content.txSignature === txSignature &&
            mem.content.status === "pending_execution"
        );
        return deposit?.content as PendingDeposit || null;
    }

    private async getPendingTransactions(token: string): Promise<PendingTransaction[]> {
        const now = Date.now();
        const transactions = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.TREASURY,
            count: 100
        });
        return transactions
            .filter(mem => {
                const content = mem.content as PendingTransaction;
                return content.type === "pending_transaction" &&
                       content.status === "pending_execution" &&
                       content.fromToken === token &&
                       content.expiresAt > now;
            })
            .map(mem => mem.content as PendingTransaction);
    }

    private async handleWalletRegistration(registration: WalletRegistration): Promise<void> {
        await this.executeAtomicOperation(async () => {
            // Check for existing registration
            const existing = await this.getRegisteredWallet(registration.userId);
            if (existing && existing.walletAddress !== registration.walletAddress) {
                throw new Error("User already has a different wallet registered");
            }

            // Create registration record
            await this.createMemory({
                type: "wallet_registration",
                id: stringToUuid(`reg-${registration.walletAddress}`),
                text: `Registered wallet ${registration.walletAddress} for user ${registration.userId}`,
                walletAddress: registration.walletAddress,
                userId: registration.userId,
                discordId: registration.discordId,
                status: "executed",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        });
    }

    private async handleDeposit(deposit: DepositContent): Promise<void> {
        await this.executeAtomicOperation(async () => {
            // Create deposit record
            await this.createMemory({
                type: "deposit_received",
                id: stringToUuid(`deposit-${deposit.txSignature}`),
                text: `Deposit ${deposit.txSignature} received`,
                txSignature: deposit.txSignature,
                fromAddress: deposit.fromAddress,
                toAddress: deposit.toAddress,
                amount: deposit.amount,
                token: deposit.token,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        });
    }

    private async handleTransfer(transfer: TransferContent): Promise<void> {
        try {
            // Create transaction record
            const transaction: TreasuryTransaction = {
                type: "treasury_transaction",
                id: stringToUuid(`tx-${transfer.txSignature || Date.now()}`),
                txHash: transfer.txSignature || "",
                timestamp: Date.now(),
                from: transfer.fromAddress,
                to: transfer.toAddress,
                amount: transfer.amount,
                token: transfer.token,
                status: "pending_execution",
                initiator: stringToUuid(transfer.initiator),
                text: `Transfer of ${transfer.amount} ${transfer.token}`,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await this.createMemory(transaction);

            // Log action
            await this.logAction(
                "transfer",
                {
                    ...transfer,
                    id: stringToUuid(`tx-${transfer.txSignature}`),
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "pending_execution",
                    text: `Processing transfer to ${transfer.toAddress}`
                } as BaseContent,
                true
            );

            elizaLogger.info(`Processing transfer ${transfer.txSignature}`);
        } catch (error) {
            elizaLogger.error(`Error handling transfer:`, error);
            await this.logAction(
                "transfer",
                {
                    ...transfer,
                    id: stringToUuid(`tx-${transfer.txSignature}`),
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    status: "failed",
                    text: `Failed to process transfer`,
                    error: error instanceof Error ? error.message : String(error)
                } as BaseContent,
                false
            );
        }
    }

    private async handleVerification(deposit: DepositContent): Promise<void> {
        try {
            const pendingDeposit = await this.getPendingDeposit(deposit.txSignature);
            if (!pendingDeposit) {
                throw new Error(`No pending deposit found for ${deposit.txSignature}`);
            }

            // Create verified deposit record
            await this.createMemory({
                ...pendingDeposit,
                id: stringToUuid(`verified-${deposit.txSignature}`),
                status: "executed",
                verificationTimestamp: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                agentId: this.runtime.agentId
            });

            // Create transaction record
            await this.createMemory({
                type: "treasury_transaction",
                id: stringToUuid(`tx-${deposit.txSignature}`),
                txHash: deposit.txSignature as string,
                timestamp: Date.now(),
                from: deposit.walletAddress as string,
                to: this.id,
                amount: deposit.amount as string,
                token: deposit.token as string,
                status: "executed",
                initiator: deposit.userId,
                text: `Deposit of ${deposit.amount} ${deposit.token}`,
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });

            elizaLogger.info(`Verified deposit ${deposit.txSignature}`);
        } catch (error) {
            elizaLogger.error(`Error verifying deposit:`, error);
            throw error;
        }
    }

    private async handleStrategyExecution(request: StrategyExecutionRequest): Promise<void> {
        try {
            // Validate request
            if (!await this.validateStrategyExecution(request)) {
                throw new Error("Invalid strategy execution request");
            }

            // Execute the swap
            const swapResult = await this.swapService.executeSwap(
                request.token,
                request.baseToken,
                parseFloat(request.amount),
                this.id
            );

            // Create success result content
            const resultContent: BaseContent = {
                type: "strategy_execution_result",
                id: stringToUuid(`result-${request.id}`),
                text: `Successfully executed strategy ${request.strategyId}`,
                agentId: this.id,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "executed",
                requestId: request.requestId,
                success: true,
                txSignature: swapResult,
                executedAmount: request.amount,
                executionPrice: request.price
            };

            // Store result in memory
            await this.createMemory(resultContent);

            // Send result message
            await this.sendMessage({
                type: "strategy_execution_result",
                content: resultContent,
                from: AgentTypes.TREASURY,
                to: "ALL",
                priority: "high",
                timestamp: Date.now()
            });

            elizaLogger.info(`Strategy execution completed: ${request.strategyId}`);
        } catch (error) {
            elizaLogger.error(`Error executing strategy:`, error);

            // Create failure result content
            const errorContent: BaseContent = {
                type: "strategy_execution_result",
                id: stringToUuid(`result-${request.id}`),
                text: `Failed to execute strategy ${request.strategyId}`,
                agentId: this.id,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                status: "failed",
                requestId: request.requestId,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };

            // Store result in memory
            await this.createMemory(errorContent);

            // Send result message
            await this.sendMessage({
                type: "strategy_execution_result",
                content: errorContent,
                from: AgentTypes.TREASURY,
                to: "ALL",
                priority: "high",
                timestamp: Date.now()
            });
        }
    }

    private async validateStrategyExecution(request: StrategyExecutionRequest): Promise<boolean> {
        // Validate the request has required fields
        if (!request.token || !request.baseToken || !request.amount) {
            return false;
        }

        try {
            // Check if we have sufficient balance
            const balance = await this.walletProvider.fetchPortfolioValue(this.runtime);
            const tokenBalance = balance.items.find(item => item.address === request.token);
            
            if (!tokenBalance || parseFloat(tokenBalance.uiAmount) < parseFloat(request.amount)) {
                elizaLogger.warn(`Insufficient balance for strategy execution:`, {
                    required: request.amount,
                    available: tokenBalance?.uiAmount || "0"
                });
                return false;
            }

            return true;
        } catch (error) {
            elizaLogger.error(`Error validating strategy execution:`, error);
            return false;
        }
    }

    private async getAvailableBalance(token: string): Promise<string> {
        // Get current balance
        const balances = await this.tokenProvider.getTokensInWallet(this.runtime);
        const tokenBalance = balances.find(b => b.address === token);
        const currentBalance = tokenBalance ? tokenBalance.balance : "0";

        // Get pending amounts
        const pendingTxs = await this.getPendingTransactions(token);
        const pendingAmount = pendingTxs.reduce(
            (sum, tx) => sum + BigInt(tx.amount),
            BigInt(0)
        );

        // Return available balance (current - pending)
        return (BigInt(currentBalance) - pendingAmount).toString();
    }

    private async trackPendingTransaction(
        id: string,
        type: "swap" | "transfer",
        fromToken: string,
        amount: string
    ): Promise<void> {
        const TRANSACTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
        await this.createMemory({
            type: "pending_transaction",
            id: stringToUuid(`pending-${id}`),
            text: `Pending ${type} of ${amount} ${fromToken}`,
            transactionId: id,
            transactionType: type,
            fromToken,
            amount,
            status: "pending_execution",
            timestamp: Date.now(),
            expiresAt: Date.now() + TRANSACTION_TIMEOUT,
            agentId: this.id,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    }

    private async completePendingTransaction(id: string): Promise<void> {
        const pendingTx = (await this.getPendingTransactions("")).find(tx => tx.transactionId === id);
        if (pendingTx) {
            await this.createMemory({
                ...pendingTx,
                id: stringToUuid(`completed-${id}`),
                status: "executed",
                updatedAt: Date.now(),
                agentId: this.runtime.agentId
            });
        }
    }

    private async validateSwapRequest(request: SwapRequest): Promise<boolean> {
        try {
            // Get available balance (accounts for pending transactions)
            const availableBalance = await this.getAvailableBalance(request.fromToken);
            
            // Check if amount exceeds available balance
            if (BigInt(request.amount) > BigInt(availableBalance)) {
                elizaLogger.warn(`Insufficient available balance for swap request`, {
                    requestAmount: request.amount,
                    availableBalance,
                    fromToken: request.fromToken
                });
                return false;
            }

            // Additional validations
            const maxSwapAmount = this.runtime.getSetting("maxSwapAmount");
            if (maxSwapAmount && BigInt(request.amount) > BigInt(maxSwapAmount)) {
                elizaLogger.warn(`Swap amount exceeds maximum allowed`, {
                    requestAmount: request.amount,
                    maxAmount: maxSwapAmount
                });
                return false;
            }

            // Validate token pair is allowed
            const allowedTokens = this.runtime.getSetting("allowedTokens")?.split(",") || [];
            if (allowedTokens.length > 0 && 
                (!allowedTokens.includes(request.fromToken) || !allowedTokens.includes(request.toToken))) {
                elizaLogger.warn(`Token pair not allowed`, {
                    fromToken: request.fromToken,
                    toToken: request.toToken,
                    allowedTokens
                });
                return false;
            }

            return true;
        } catch (error) {
            elizaLogger.error(`Error validating swap request:`, error);
            return false;
        }
    }

    public async handleSwapRequest(request: SwapRequest): Promise<void> {
        await this.executeAtomicOperation(async () => {
            try {
                // Validate request
                if (!await this.validateSwapRequest(request)) {
                    throw new Error("Swap request validation failed");
                }

                // Track pending transaction
                await this.trackPendingTransaction(
                    request.id,
                    "swap",
                    request.fromToken,
                    request.amount
                );

                // Execute swap
                const swapResult = await this.swapService.executeSwap(
                    request.fromToken,
                    request.toToken,
                    parseFloat(request.amount),
                    this.id
                );

                // Complete pending transaction
                await this.completePendingTransaction(request.id);

                // Create success result message
                const resultContent = {
                    type: "proposal_execution_result",
                    id: stringToUuid(`swap-${Date.now()}`),
                    text: `Swap executed successfully: ${request.amount} ${request.fromToken} -> ${request.toToken}`,
                    requestId: request.id,
                    success: true,
                    txSignature: swapResult,
                    executedAmount: request.amount,
                    executionPrice: request.price,
                    status: "executed" as const,
                    agentId: this.runtime.agentId,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    metadata: {
                        proposalId: request.sourceId,
                        sourceAgent: request.sourceAgent
                    }
                };

                // Store result in memory
                await this.createMemory(resultContent);

                // Send result message
                await this.sendMessage({
                    type: "swap_request",
                    content: resultContent,
                    from: AgentTypes.TREASURY,
                    to: "ALL",
                    priority: "high",
                    timestamp: Date.now()
                });

                elizaLogger.info(`Swap executed successfully: ${request.amount} ${request.fromToken} -> ${request.toToken}`);
            } catch (error) {
                // Clean up pending transaction on failure
                const pendingTx = (await this.getPendingTransactions("")).find(tx => tx.transactionId === request.id);
                if (pendingTx) {
                    await this.createMemory({
                        ...pendingTx,
                        id: stringToUuid(`failed-${request.id}`),
                        agentId: this.runtime.agentId,
                        status: "failed",
                        updatedAt: Date.now()
                    });
                }
                
                elizaLogger.error(`Error handling swap request:`, error);
                throw error;
            }
        });
    }

    public async validateAction(content: BaseContent): Promise<boolean> {
        switch (content.type) {
            case "registration":
                return this.validateRegistration(content as unknown as WalletRegistration);
            case "deposit_received":
                return this.validateDeposit(content as unknown as DepositContent);
            case "transfer":
                return this.validateTransfer(content as unknown as TransferContent);
            default:
                return false;
        }
    }

    public async validateRegistration(registration: WalletRegistration): Promise<boolean> {
        // Basic validation
        if (!registration.walletAddress || !registration.userId) {
            return false;
        }

        // Check if wallet is already registered
        const existingRegistration = await this.getRegisteredWallet(registration.userId);
        if (existingRegistration && existingRegistration.walletAddress !== registration.walletAddress) {
            return false;
        }

        return true;
    }

    public async validateDeposit(deposit: DepositContent): Promise<boolean> {
        // Basic validation
        if (!deposit.txSignature || !deposit.amount || !deposit.token) {
            return false;
        }

        // Check if deposit is already processed
        const existingDeposit = await this.getPendingDeposit(deposit.txSignature);
        if (existingDeposit) {
            return false;
        }

        return true;
    }

    private async validateTransfer(transfer: TransferContent): Promise<boolean> {
        // Basic validation
        if (!transfer.toAddress || !transfer.amount || !transfer.token) {
            return false;
        }

        // Check if we have sufficient balance
        const balances = await this.walletProvider.fetchPortfolioValue(this.runtime);
        const tokenBalance = balances.items.find(item => item.address === transfer.token);

        if (!tokenBalance || parseFloat(tokenBalance.uiAmount) < parseFloat(transfer.amount)) {
            return false;
        }

        return true;
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        switch (content.type) {
            case "registration":
                await this.handleWalletRegistration(content as unknown as WalletRegistration);
                break;
            case "deposit_received":
                await this.handleDeposit(content as unknown as DepositContent);
                break;
            case "transfer":
                await this.handleTransfer(content as unknown as TransferContent);
                break;
            default:
                elizaLogger.warn(`Invalid action type: ${content.type}`);
                return false;
        }

        return true;
    }

    public async getTransaction(txHash: string): Promise<TreasuryTransaction | null> {
        const transactions = await this.runtime.messageManager.getMemories({
            roomId: ROOM_IDS.TREASURY,
            count: 1
        });
        const transaction = transactions.find(mem =>
            mem.content.type === "treasury_transaction" &&
            mem.content.txHash === txHash
        );
        return transaction?.content as TreasuryTransaction || null;
    }

    public async getBalance(userId: UUID): Promise<TokenBalance[]> {
        const registration = await this.getRegisteredWallet(userId);
        if (!registration) {
            return [];
        }

        const balances = await this.walletProvider.fetchPortfolioValue(this.runtime);
        return balances.items.map(item => ({
            token: item.address,
            amount: item.balance,
            uiAmount: item.uiAmount,
            decimals: item.decimals,
            usdValue: item.valueUsd
        }));
    }

    public async initialize(): Promise<void> {
        await super.initialize();

        // Initialize providers
        const connection = new Connection(
            this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        const walletPubkey = new PublicKey(this.id);
        this.walletProvider = new WalletProvider(connection, walletPubkey);
        this.tokenProvider = new TokenProvider(
            "So11111111111111111111111111111111111111112", // SOL mint address
            this.walletProvider,
            this.runtime.cacheManager
        );
        this.swapService = new SwapService(this.runtime);

        // Register capabilities
        this.loadActions();

        // Set up swap tracking
        this.setupSwapTracking();

        elizaLogger.info("Treasury Agent initialized");
    }

    private isSwapDetails(details: any): details is SwapDetails {
        return details && 
            typeof details === 'object' &&
            'type' in details &&
            details.type === 'swap' &&
            'inputToken' in details &&
            'outputToken' in details &&
            'amount' in details;
    }

    private async handleProposalExecution(proposal: ProposalContent): Promise<void> {
        try {
            if (!proposal.interpretation || !this.isSwapDetails(proposal.interpretation.details)) {
                elizaLogger.warn(`Invalid proposal interpretation for ${proposal.id}`);
                return;
            }

            const swapDetails = proposal.interpretation.details;
            const swapRequest: SwapRequest = {
                type: "swap_request",
                id: stringToUuid(`swap-${proposal.id}`),
                text: `Swap request from proposal ${proposal.id}`,
                fromToken: swapDetails.inputToken,
                toToken: swapDetails.outputToken,
                amount: swapDetails.amount,
                status: "pending_execution",
                agentId: this.runtime.agentId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                reason: "proposal_passed",
                requestId: stringToUuid(`req-${Date.now()}`),
                sourceAgent: "PROPOSAL",
                sourceId: proposal.id,
                metadata: {
                    proposalId: proposal.id,
                    tags: ["swap", "proposal"],
                    priority: "high"
                }
            };

            await this.handleSwapRequest(swapRequest);
        } catch (error) {
            elizaLogger.error(`Error executing proposal ${proposal.id}:`, error);
        }
    }

    private async handleTransaction(transaction: TreasuryTransaction): Promise<void> {
        try {
            // Update transaction status in memory
            await this.createMemory({
                ...transaction,
                id: stringToUuid(`tx-status-${transaction.id}`),
                updatedAt: Date.now()
            });

            // If transaction is executed, update balances
            if (transaction.status === "executed") {
                await this.updateBalances(transaction);
            }
        } catch (error) {
            elizaLogger.error(`Error handling transaction status change:`, error);
        }
    }

    private async updateBalances(transaction: TreasuryTransaction): Promise<void> {
        // Implementation for updating balances after transaction
        // This would typically involve fetching new balances and storing them
    }

    private async processMemory(memory: Memory): Promise<void> {
        const content = memory.content as BaseContent;
        switch (content.type) {
            case "swap_request":
                if (this.isSwapRequest(content)) {
                    await this.handleSwapRequest(content);
                }
                break;
            case "proposal_passed":
                if (this.isProposalContent(content) && this.isProposalWithSwap(content)) {
                    await this.handleProposalExecution(content);
                }
                break;
            default:
                elizaLogger.debug(`Unhandled memory type: ${content.type}`);
        }
    }
} 