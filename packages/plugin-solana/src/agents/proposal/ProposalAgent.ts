import { 
    elizaLogger, 
    stringToUuid,
    UUID,
    Memory
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent";
import {
    AgentMessage,
    BaseContent,
    ContentStatus,
    isValidContentStatus,
    ContentStatusIndex,
    getContentStatus,
    isValidStatusTransition,
    MemoryMetadata,
    isUniqueMemoryType
} from "../../shared/types/base";
import {
    VoteContent,
    Vote,
    VoteStats,
    ProposalContent
} from "../../shared/types/vote";
import {
    ProposalInterpretation,
    ProposalStatus,
    SwapDetails,
    StrategyDetails,
    GovernanceDetails,
    ParameterChangeDetails,
    OtherDetails,
    ProposalType
} from "../../shared/types/proposal";
import {
    DAOMemoryType,
    DAOMemoryContent,
    createMemoryContent,
    createProposalMemoryContent
} from "../../shared/types/memory";
import { findProposal } from "../../shared/utils/proposal";
import { getMemoryRoom, ROOM_IDS } from "../../shared/constants";
import { IAgentRuntime as SolanaAgentRuntime } from "../../shared/types/base";

// Update DAOMemoryType to include proposal_execution_result
type ExtendedDAOMemoryType = DAOMemoryType | "proposal_execution_result";

const proposalInterpretTemplate = `You are a DAO proposal interpreter. Analyze the following proposal command and provide a natural interpretation.

Original Command: {{message.content.text}}

Format the response as a JSON object with:
- A clear, concise title
- A detailed description in natural language
- The proposal type (swap/strategy/governance/other)
- Any relevant numerical details (amounts, prices, etc.)

Example for a swap:
{
    "title": "Swap 3 SOL for USDC",
    "description": "Proposal to exchange 3 SOL tokens for USDC from the DAO treasury. This swap will be executed through Jupiter aggregator for the best possible price.",
    "type": "swap",
    "details": {
        "inputToken": "SOL",
        "outputToken": "USDC",
        "amount": 3
    }
}`;

interface ProposalAgentConfig {
    quorum: number;
    minimumYesVotes: number;
    minimumVotePercentage: number;
    maxProposalsPerUser: number;
    proposalExpiryDays: number;
}

interface ProposalExecutionResult extends BaseContent {
    type: "proposal_execution_result";
    proposalId: UUID;
    success: boolean;
    error?: string;
    executedBy: UUID;
    timestamp: number;
}

// Add utility functions at the top of the file
function generateShortId(): string {
    return Math.random().toString(36).substring(2, 15);
}

export class ProposalAgent extends BaseAgent {
    private config: ProposalAgentConfig;
    private proposalMonitorInterval: NodeJS.Timeout | null = null;
    private executionTimeouts: Map<UUID, NodeJS.Timeout> = new Map();
    private readonly EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    
    constructor(runtime: SolanaAgentRuntime) {
        super(runtime);
    }

    public async initialize(): Promise<void> {
        await super.initialize();
        
        // Initialize config with defaults and environment settings
        this.config = {
            quorum: parseInt(this.runtime.getSetting("proposalQuorum") || "3", 10),
            minimumYesVotes: parseInt(this.runtime.getSetting("proposalMinimumYesVotes") || "0", 10),
            minimumVotePercentage: parseInt(this.runtime.getSetting("proposalMinimumVotePercentage") || "50", 10),
            maxProposalsPerUser: parseInt(this.runtime.getSetting("maxProposalsPerUser") || "3", 10),
            proposalExpiryDays: parseInt(this.runtime.getSetting("proposalExpiryDays") || "7", 10)
        };

        elizaLogger.info("ProposalAgent initialized with config:", this.config);
        
        // Set up proposal tracking and monitoring
        this.setupProposalTracking();
        this.setupCrossProcessEvents();
    }

    private setupProposalTracking(): void {
        // Core proposal-related memory subscriptions
        this.subscribeToMemory("proposal", async (memory) => {
            const content = memory.content as ProposalContent;
            await this.processProposalUpdate(content);
        });

        this.subscribeToMemory("vote_cast", async (memory) => {
            const content = memory.content as VoteContent;
            await this.handleVote(content);
        });

        this.subscribeToMemory("proposal_execution_result", async (memory) => {
            const content = memory.content as ProposalExecutionResult;
            if (!content.proposalId) return;

            // Clear any pending timeout
            const timeout = this.executionTimeouts.get(content.proposalId);
            if (timeout) {
                clearTimeout(timeout);
                this.executionTimeouts.delete(content.proposalId);
            }

            // Update proposal status based on execution result
            await this.handleExecutionResult(content);
        });
    }

    protected async handleMessage(message: AgentMessage): Promise<void> {
        try {
            const content = message.content?.text?.toLowerCase() || "";
            
            if (content.includes("proposal")) {
                await this.processProposalMessage(message);
            }
        } catch (error) {
            elizaLogger.error("Error handling proposal message:", error);
        }
    }

    private async processProposalMessage(message: AgentMessage): Promise<void> {
        const content = message.content;
        
        switch (content.type) {
            case "cancel_proposal":
                if (this.isValidProposalContent(content)) {
                    await this.handleCancelProposal(content);
                }
                break;
            case "proposal_execution_result":
                await this.handleExecutionResult(content as ProposalExecutionResult);
                break;
            default:
                elizaLogger.debug(`Unhandled proposal message type: ${content.type}`);
        }
    }

    private async handleProposalMemory(content: DAOMemoryContent): Promise<void> {
        try {
            if (!content.metadata?.proposalId) {
                return;
            }

            const proposal = await this.getProposal(content.metadata.proposalId as UUID);
            if (!proposal) {
                return;
            }

            switch (content.type as ExtendedDAOMemoryType) {
                case "proposal_status_changed":
                    await this.createMemory({
                        ...proposal,
                        status: content.status as ProposalStatus,
                        updatedAt: Date.now(),
                        roomId: ROOM_IDS.DAO
                    });
                    break;
                case "proposal_execution_result":
                    if (this.isProposalExecutionResult(content)) {
                        await this.handleExecutionResult(content);
                    }
                    break;
                default:
                    elizaLogger.debug(`Unhandled proposal memory type: ${content.type}`);
            }
        } catch (error) {
            elizaLogger.error(`Error handling proposal memory:`, error);
        }
    }

    private isValidProposalContent(content: any): content is ProposalContent {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'proposal' &&
            'title' in content &&
            'description' in content &&
            'id' in content &&
            'status' in content;
    }

    private isProposalExecutionResult(content: any): content is ProposalExecutionResult {
        return content &&
            typeof content === 'object' &&
            'type' in content &&
            content.type === 'proposal_execution_result' &&
            'proposalId' in content &&
            'success' in content &&
            'executedBy' in content &&
            'timestamp' in content;
    }

    // Implement abstract methods from BaseAgent
    protected async validateAction(content: BaseContent): Promise<boolean> {
        if (!content || typeof content !== 'object') {
            return false;
        }

        switch (content.type) {
            case "proposal":
                return this.isValidProposalContent(content);
            case "proposal_execution_result":
                return true; // Add validation if needed
            default:
                return false;
        }
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        try {
            switch (content.type) {
                case "proposal":
                    if (this.isValidProposalContent(content)) {
                        await this.processProposalUpdate(content);
                        return true;
                    }
                    break;
                case "proposal_execution_result":
                    await this.handleExecutionResult(content as ProposalExecutionResult);
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
        await this.handleProposalMemory(content);
    }

    protected loadActions(): void {
        this.registerCapability({
            name: "proposal_execution",
            description: "Execute DAO proposals",
            requiredPermissions: ["execute_proposals"],
            actions: ["execute_proposal", "cancel_proposal"]
        });
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // Monitor proposals
        this.proposalMonitorInterval = setInterval(async () => {
            try {
                const activeProposals = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: 100
                });

                // Filter and process active proposals
                const proposals = activeProposals.filter(memory => {
                    if (!memory.content) return false;
                    const content = memory.content as Partial<ProposalContent>;
                    return content.type === "proposal" && 
                           content.status === "open";
                });

                for (const proposal of proposals) {
                    await this.checkProposalStatus(proposal.content as ProposalContent);
                }
            } catch (error) {
                elizaLogger.error("Error monitoring proposals:", error);
            }
        }, 60000); // Check every minute

        // Handle execution results
        this.messageBroker.on("proposal_executed", async (event) => {
            await this.handleExecutionResult(event);
        });
    }

    // Implementation methods
    private async processProposalUpdate(content: ProposalContent): Promise<void> {
        try {
            const now = Date.now();
            const deadline = now + (this.config.proposalExpiryDays * 24 * 60 * 60 * 1000);

            // Create a complete proposal object with all required fields
            const proposal: ProposalContent = {
                ...content,
                type: "proposal",
                id: content.id || stringToUuid(`proposal-${now}`),
                shortId: content.shortId || generateShortId(),
                title: content.title,
                description: content.description,
                text: content.text || content.description,
                proposer: content.proposer,
                agentId: this.runtime.agentId,
                status: "open",
                yes: [],
                no: [],
                deadline,
                createdAt: now,
                updatedAt: now,
                interpretation: content.interpretation || {
                    type: "other" as ProposalType,
                    details: {
                        type: "other",
                        description: content.description
                    }
                },
                votingConfig: {
                    quorumThreshold: this.config.quorum,
                    minimumYesVotes: this.config.minimumYesVotes,
                    minimumVotePercentage: this.config.minimumVotePercentage,
                    votingPeriod: this.config.proposalExpiryDays * 24 * 60 * 60 * 1000
                },
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
                metadata: {
                    ...(content.metadata || {}),
                    tags: [...(content.metadata?.tags || []), "proposal"],
                    priority: content.metadata?.priority || "medium",
                    proposalType: (content.interpretation && typeof content.interpretation === 'object' && 'type' in content.interpretation ? content.interpretation.type as ProposalType : "other"),
                    requiresExecution: true
                }
            };

            await this.createMemory(proposal);
            elizaLogger.info(`Processed proposal update for ${proposal.id}`, {
                title: proposal.title,
                proposer: proposal.proposer,
                deadline: new Date(deadline).toISOString()
            });
        } catch (error) {
            elizaLogger.error(`Error processing proposal update:`, error);
        }
    }

    private async updateVoteStats(proposal: ProposalContent): Promise<void> {
        const stats = {
            total: proposal.yes.length + proposal.no.length,
            yes: proposal.yes.length,
            no: proposal.no.length,
            totalVotingPower: 0,
            totalYesPower: 0,
            totalNoPower: 0,
            yesPowerPercentage: 0,
            quorumReached: false,
            minimumYesVotesReached: false,
            minimumPercentageReached: false
        };

        // Calculate voting power totals
        stats.totalYesPower = proposal.yes.reduce((sum, vote) => sum + vote.votingPower, 0);
        stats.totalNoPower = proposal.no.reduce((sum, vote) => sum + vote.votingPower, 0);
        stats.totalVotingPower = stats.totalYesPower + stats.totalNoPower;

        // Calculate percentage
        stats.yesPowerPercentage = stats.totalVotingPower > 0 
            ? (stats.totalYesPower / stats.totalVotingPower) * 100 
            : 0;

        // Check against thresholds from config
        stats.quorumReached = stats.totalVotingPower >= this.config.quorum;
        stats.minimumYesVotesReached = stats.yes >= this.config.minimumYesVotes;
        stats.minimumPercentageReached = stats.yesPowerPercentage >= this.config.minimumVotePercentage;

        // Update proposal stats
        proposal.voteStats = stats;
        await this.createMemory(proposal);
    }

    private async checkProposalStatus(proposal: ProposalContent): Promise<void> {
        // Update vote stats first
        await this.updateVoteStats(proposal);

        const { voteStats } = proposal;
        const now = Date.now();
        const deadline = proposal.createdAt + (this.config.proposalExpiryDays * 24 * 60 * 60 * 1000);

        // Check if voting period has ended
        if (now >= deadline) {
            if (voteStats.quorumReached && 
                voteStats.minimumYesVotesReached && 
                voteStats.minimumPercentageReached) {
                // Proposal passed
                proposal.status = "pending_execution";
            } else {
                // Proposal rejected
                proposal.status = "rejected";
            }
            proposal.updatedAt = now;
            await this.createMemory(proposal);
        }
    }

    private async handleCancelProposal(proposal: ProposalContent): Promise<void> {
        // Implementation here
    }

    private async handleExecutionResult(result: ProposalExecutionResult): Promise<void> {
        // Implementation here
    }

    private async getProposal(id: UUID): Promise<ProposalContent | null> {
        // Implementation here
        return null;
    }

    private async handleVote(content: VoteContent): Promise<void> {
        try {
            // Find the associated proposal
            const proposalId = content.metadata?.proposalId;
            if (!proposalId) {
                elizaLogger.error("No proposal ID found in vote content");
                return;
            }

            const proposal = await findProposal(this.runtime, stringToUuid(proposalId));
            if (!proposal) {
                elizaLogger.error(`Proposal not found for vote: ${proposalId}`);
                return;
            }

            const proposalContent = proposal.content as ProposalContent;
            const userId = stringToUuid(content.agentId.toString());
            const timestamp = Date.now();
            
            // Add vote to the appropriate array
            const vote: Vote = {
                userId,
                votingPower: 1, // Default voting power
                timestamp
            };

            if (content.metadata?.vote === "yes") {
                proposalContent.yes.push(vote);
            } else {
                proposalContent.no.push(vote);
            }

            // Update vote stats
            await this.updateVoteStats(proposalContent);
            
            // Check if the vote changes the proposal status
            await this.checkProposalStatus(proposalContent);

        } catch (error) {
            elizaLogger.error("Error handling vote:", error);
        }
    }

    public override async shutdown(): Promise<void> {
        if (this.proposalMonitorInterval) {
            clearInterval(this.proposalMonitorInterval);
            this.proposalMonitorInterval = null;
        }
        // Clear all execution timeouts
        for (const timeout of this.executionTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.executionTimeouts.clear();
        
        await super.shutdown();
    }
}