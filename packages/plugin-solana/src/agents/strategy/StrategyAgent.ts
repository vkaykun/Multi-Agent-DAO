// packages/plugin-solana/src/agents/strategy/StrategyAgent.ts

import {
    IAgentRuntime,
    elizaLogger,
    stringToUuid,
    UUID,
    Memory,
    State,
    Service,
    ServiceType as CoreServiceType
} from "@elizaos/core";

// Extend the core ServiceType
declare module "@elizaos/core" {
    export enum ServiceType {
        STRATEGY_EXECUTOR = "STRATEGY_EXECUTOR"
    }
}

import { BaseAgent } from "../../shared/BaseAgent";
import {
    AgentMessage,
    BaseContent,
    ContentStatus,
    ContentStatusIndex,
    getContentStatus,
    ServiceType
} from "../../shared/types/base";
import {
    StrategyContent,
    StrategyType,
    StrategyCondition,
    StrategyExecution,
    PositionUpdate,
    StrategyExecutionRequest,
    StrategyExecutionResult,
    StrategyStatus
} from "../../shared/types/strategy";
import { SwapRequest } from "../../shared/types/treasury";
import { DAOMemoryType, DAOMemoryContent, createMemoryContent, createStrategyMemoryContent } from "../../shared/types/memory";
import { TokenProvider } from "../../providers/token";
import { WalletProvider } from "../../providers/wallet";
import { Connection, PublicKey } from "@solana/web3.js";
import crypto from 'crypto';
import { ROOM_IDS } from "../../shared/constants";
import { IAgentRuntime as SolanaAgentRuntime } from "../../shared/types/base";

export class StrategyAgent extends BaseAgent {
    private walletProvider: WalletProvider;
    private tokenProvider: TokenProvider;

    constructor(runtime: SolanaAgentRuntime) {
        super(runtime);
        
        // Initialize providers
        const connection = new Connection(
            this.runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
        );
        const walletPubkey = new PublicKey(this.id);
        this.walletProvider = new WalletProvider(connection, walletPubkey);
        this.tokenProvider = new TokenProvider(
            "So11111111111111111111111111111111111111112",
            this.walletProvider,
            this.runtime.cacheManager
        );

        this.registerCapabilities();
    }

    private registerCapabilities(): void {
        this.registerCapability({
            name: "strategy_management",
            description: "Create and manage trading strategies",
            requiredPermissions: ["manage_strategies"],
            actions: ["create", "update", "cancel"]
        });

        this.registerCapability({
            name: "position_monitoring",
            description: "Monitor positions and execute strategies",
            requiredPermissions: ["monitor_positions", "execute_trades"],
            actions: ["monitor", "execute"]
        });
    }

    public async initialize(): Promise<void> {
        await super.initialize();
        
        // Subscribe to strategy-related updates
        this.subscribeToMemory("strategy", this.handleStrategyUpdate.bind(this));
        this.subscribeToMemory("position_update", this.handlePositionUpdate.bind(this));
        this.subscribeToMemory("strategy_execution_result", async (memory) => {
            const content = memory.content as StrategyExecutionResult;
            await this.handleExecutionResult(content);
        });

        elizaLogger.info("Strategy agent initialized");
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            const content = message.content?.text?.toLowerCase() || "";
            
            if (content.includes("strategy") || content.includes("position")) {
                await this.processStrategyMessage(message);
            }
        } catch (error) {
            elizaLogger.error("Error handling strategy message:", error);
        }
    }

    private async processStrategyMessage(message: AgentMessage): Promise<void> {
        // Strategy message processing logic here
        const content = message.content;
        
        switch (content.type) {
            case "cancel_strategy":
                if (this.isValidStrategyContent(content)) {
                    await this.handleCancelStrategy(content);
                }
                break;
            case "strategy_cancellation":
                if (content.metadata?.strategyId) {
                    const strategy = await this.getStrategy(content.metadata.strategyId as UUID);
                    if (strategy) {
                        await this.handleCancelStrategy(strategy);
                    }
                }
                break;
            case "price_update":
                if (this.isValidPositionUpdate(content)) {
                    await this.handlePriceUpdate(content);
                }
                break;
            case "strategy_execution_result":
                await this.handleExecutionResult(content as StrategyExecutionResult);
                break;
            default:
                elizaLogger.debug(`Unhandled strategy message type: ${content.type}`);
        }
    }

    private async handleStrategyMemory(content: DAOMemoryContent): Promise<void> {
        try {
            if (!content.metadata?.strategyId) {
                return;
            }

            const strategy = await this.getStrategy(content.metadata.strategyId as UUID);
            if (!strategy) {
                return;
            }

            switch (content.type) {
                case "strategy_status_changed":
                    await this.createMemory({
                        ...strategy,
                        status: content.status as StrategyStatus,
                        updatedAt: Date.now(),
                        roomId: ROOM_IDS.DAO
                    });
                    break;
                case "strategy_execution_result":
                    await this.handleExecutionResult(content as StrategyExecutionResult);
                    break;
                default:
                    elizaLogger.debug(`Unhandled strategy memory type: ${content.type}`);
            }
        } catch (error) {
            elizaLogger.error(`Error handling strategy memory:`, error);
        }
    }

    private isValidStrategyContent(content: any): content is StrategyContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'strategy' &&
            'token' in content &&
            'baseToken' in content &&
            'strategyType' in content &&
            'id' in content &&
            'status' in content;
    }

    private isValidPositionUpdate(content: any): content is PositionUpdate {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'position_update' &&
            'token' in content &&
            'price' in content &&
            'size' in content;
    }

    private async handleStrategyUpdate(memory: Memory): Promise<void> {
        const content = memory.content;
        if (!this.isValidStrategyContent(content)) return;
        
        try {
            await this.processStrategyUpdate(content);
        } catch (error) {
            elizaLogger.error("Error handling strategy update:", error);
        }
    }

    private async handlePositionUpdate(memory: Memory): Promise<void> {
        const position = memory.content;
        if (!this.isValidPositionUpdate(position)) return;
        
        const strategies = await this.queryMemories<StrategyContent>({
            type: "strategy",
            filter: (s): s is StrategyContent => 
                this.isValidStrategyContent(s) &&
                s.token === position.token && 
                s.status !== "executed" && 
                s.status !== "cancelled"
        });

        for (const strategy of strategies) {
            try {
                await this.evaluateStrategy(strategy, position);
            } catch (error) {
                elizaLogger.error(`Error evaluating strategy ${strategy.id}:`, error);
            }
        }
    }

    // Implement these methods based on your business logic
    private async processStrategyUpdate(content: StrategyContent): Promise<void> {
        // Implementation here
    }

    private async evaluateStrategy(strategy: StrategyContent, position: PositionUpdate): Promise<void> {
        // Implementation here
    }

    private async handleCancelStrategy(strategy: StrategyContent): Promise<void> {
        // Implementation here
    }

    private async handlePriceUpdate(update: PositionUpdate): Promise<void> {
        // Implementation here
    }

    private async handleExecutionResult(result: StrategyExecutionResult): Promise<void> {
        // Implementation here
    }

    private async getStrategy(id: UUID): Promise<StrategyContent | null> {
        // Implementation here
        return null;
    }

    public override async shutdown(): Promise<void> {
        await super.shutdown();
    }

    // Implement abstract methods from BaseAgent
    protected async validateAction(content: BaseContent): Promise<boolean> {
        if (!content || typeof content !== 'object') {
            return false;
        }

        switch (content.type) {
            case "strategy":
                return this.isValidStrategyContent(content);
            case "position_update":
                return this.isValidPositionUpdate(content);
            case "strategy_execution_result":
                return true; // Add validation if needed
            default:
                return false;
        }
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        try {
            switch (content.type) {
                case "strategy":
                    if (this.isValidStrategyContent(content)) {
                        await this.processStrategyUpdate(content);
                        return true;
                    }
                    break;
                case "position_update":
                    if (this.isValidPositionUpdate(content)) {
                        await this.handlePriceUpdate(content);
                        return true;
                    }
                    break;
                case "strategy_execution_result":
                    await this.handleExecutionResult(content as StrategyExecutionResult);
                    return true;
            }
            return false;
        } catch (error) {
            elizaLogger.error("Error executing action:", error);
            return false;
        }
    }

    protected async handleMemory(memory: Memory): Promise<void> {
        const content = memory.content as DAOMemoryContent;
        await this.handleStrategyMemory(content);
    }

    protected loadActions(): void {
        this.registerCapability({
            name: "strategy_execution",
            description: "Execute trading strategies",
            requiredPermissions: ["execute_strategies"],
            actions: ["execute_strategy", "cancel_strategy"]
        });
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        this.messageBroker.on("strategy_executed", async (event) => {
            await this.handleExecutionResult(event);
        });
    }
} 