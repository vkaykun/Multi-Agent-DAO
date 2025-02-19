import { 
    IAgentRuntime, 
    Memory, 
    State, 
    elizaLogger,
    stringToUuid,
    UUID,
    Runtime
} from "@elizaos/core";
import { BaseAgent } from "../../shared/BaseAgent";
import { 
    UserProfile, 
    UserProfileUpdate, 
    UserActivityLog,
    UserReputationUpdate,
    REPUTATION_SCORES 
} from "../../shared/types/user";
import { ROOM_IDS } from "../../shared/constants";
import { TokenBalance } from "../../shared/types/treasury";
import { BaseContent, ContentStatus } from "../../shared/types/base";
import { StrategyExecutionResult } from "../../shared/types/strategy";
import { MemoryMetadata } from "../../shared/types/memory";

const PROFILE_SYNC_INTERVAL = 30000; // 30 seconds
const PROFILE_BATCH_SIZE = 100;

interface UserActivityMetadata extends MemoryMetadata {
    proposalId?: string;
    strategyId?: string;
    executedAmount?: number;
    executionPrice?: number;
    success?: boolean;
    userStats: {
        proposalsCreated: number;
        votesCount: number;
    };
}

export class UserProfileAgent extends BaseAgent {
    private userProfiles: Map<UUID, UserProfile>;
    private lastSyncTimestamp: number = 0;
    private syncInterval: NodeJS.Timeout | null = null;

    constructor(runtime: IAgentRuntime) {
        super(runtime);
        this.userProfiles = new Map();
        this.setupSubscriptions();
    }

    public override async initialize(): Promise<void> {
        await super.initialize();

        // Initial load of user profiles
        await this.loadUserProfiles();

        // Set up memory subscriptions for user-related events
        this.setupSubscriptions();

        // Start profile synchronization
        this.startProfileSync();

        // Subscribe to proposal creation events
        this.subscribeToMemory("proposal_created", async (memory: Memory) => {
            const content = memory.content as BaseContent;
            if (content.metadata?.proposer) {
                await this.handleNewProposal(
                    content.metadata.proposer as UUID,
                    content.metadata.proposalId as string
                );
            }
        });

        elizaLogger.info("User Profile Agent initialized");
    }

    private async loadUserProfiles(): Promise<void> {
        try {
            let lastId: UUID | undefined;
            let hasMore = true;
            const loadedProfiles = new Map<UUID, UserProfile>();

            while (hasMore) {
                const profiles = await this.runtime.messageManager.getMemories({
                    roomId: ROOM_IDS.DAO,
                    count: PROFILE_BATCH_SIZE,
                    ...(lastId ? { lastId } : {})
                });

                if (profiles.length === 0) {
                    hasMore = false;
                    continue;
                }

                profiles.forEach(memory => {
                    if (memory.content.type === "user_profile") {
                        const profile = memory.content as UserProfile;
                        loadedProfiles.set(profile.userId, profile);
                        lastId = memory.id;
                    }
                });

                hasMore = profiles.length === PROFILE_BATCH_SIZE;
            }

            // Update the profiles map atomically
            this.userProfiles = loadedProfiles;
            this.lastSyncTimestamp = Date.now();

            elizaLogger.info(`Loaded ${loadedProfiles.size} user profiles`);
        } catch (error) {
            elizaLogger.error("Error loading user profiles:", error);
        }
    }

    private startProfileSync(): void {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }

        this.syncInterval = setInterval(async () => {
            await this.syncProfiles();
        }, PROFILE_SYNC_INTERVAL);

        // Also subscribe to real-time profile updates
        this.subscribeToMemory("user_profile", async (memory) => {
            await this.handleProfileUpdate(memory);
        });
    }

    private async syncProfiles(): Promise<void> {
        try {
            // Fetch profiles updated since last sync
            const updatedProfiles = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: PROFILE_BATCH_SIZE,
                start: this.lastSyncTimestamp
            });

            let updatedCount = 0;
            for (const memory of updatedProfiles) {
                if (memory.content.type === "user_profile") {
                    const profile = memory.content as UserProfile;
                    await this.mergeProfile(profile);
                    updatedCount++;
                }
            }

            if (updatedCount > 0) {
                elizaLogger.info(`Synced ${updatedCount} updated user profiles`);
            }

            this.lastSyncTimestamp = Date.now();
        } catch (error) {
            elizaLogger.error("Error syncing profiles:", error);
        }
    }

    private async handleProfileUpdate(memory: Memory): Promise<void> {
        try {
            if (memory.content.type === "user_profile") {
                const profile = memory.content as UserProfile;
                await this.mergeProfile(profile);
                elizaLogger.debug(`Received real-time profile update for user ${profile.userId}`);
            }
        } catch (error) {
            elizaLogger.error("Error handling profile update:", error);
        }
    }

    private async mergeProfile(newProfile: UserProfile): Promise<void> {
        const existingProfile = this.userProfiles.get(newProfile.userId);
        
        // Only update if the new profile is more recent
        if (!existingProfile || newProfile.updatedAt > existingProfile.updatedAt) {
            this.userProfiles.set(newProfile.userId, newProfile);
            
            // Broadcast update to other processes
            await this.broadcastProfileUpdate(newProfile);
        }
    }

    private async broadcastProfileUpdate(profile: UserProfile): Promise<void> {
        try {
            const updateEvent = {
                type: "user_profile_updated",
                id: stringToUuid(`profile-update-${Date.now()}`),
                content: profile,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                text: `User profile updated for ${profile.userId}`
            };

            await this.runtime.messageManager.createMemory({
                id: updateEvent.id,
                content: updateEvent,
                roomId: ROOM_IDS.DAO,
                userId: profile.userId,
                agentId: this.runtime.agentId
            });
        } catch (error) {
            elizaLogger.error("Error broadcasting profile update:", error);
        }
    }

    public override async shutdown(): Promise<void> {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        await super.shutdown();
    }

    private setupSubscriptions(): void {
        // Subscribe to wallet registration events
        this.subscribeToMemory("wallet_registration", async (memory) => {
            const { walletAddress, discordId } = memory.content;
            await this.handleWalletRegistration(memory.userId, walletAddress as string, discordId as string | undefined);
        });

        // Subscribe to deposit events - using standardized deposit_received type
        this.subscribeToMemory("deposit_received", async (memory) => {
            const deposit = memory.content;
            await this.handleDeposit(memory.userId, {
                token: (deposit as any).token as string,
                amount: (deposit as any).amount as string,
                uiAmount: (deposit as any).amount as string,
                decimals: 9, // Default for SOL, should be dynamic
                usdValue: (deposit as any).usdValue as string
            });
        });

        // Subscribe to vote events
        this.subscribeToMemory("vote_cast", async (memory) => {
            await this.updateUserActivity(memory.userId, "vote", memory.content);
        });

        // Subscribe to strategy execution results
        this.subscribeToMemory("strategy_execution_result", async (memory) => {
            const content = memory.content as StrategyExecutionResult;
            if (content.success) {
                await this.updateUserActivity(memory.userId, "strategy", {
                    type: "strategy_execution",
                    strategyId: content.strategyId,
                    executedAmount: content.executedAmount,
                    executionPrice: content.executionPrice,
                    success: true,
                    userStats: {
                        proposalsCreated: 0,
                        votesCount: 0
                    }
                });
            }
        });

        // Also subscribe to strategy execution records for backwards compatibility
        this.subscribeToMemory("strategy_execution", async (memory) => {
            const content = memory.content;
            if (content.status === "executed") {
                await this.updateUserActivity(memory.userId, "strategy", {
                    type: "strategy_execution",
                    strategyId: content.strategyId,
                    executedAmount: content.amountExecuted,
                    executionPrice: content.priceAtExecution,
                    success: true,
                    userStats: {
                        proposalsCreated: 0,
                        votesCount: 0
                    }
                });
            }
        });
    }

    private async handleWalletRegistration(
        userId: UUID,
        walletAddress: string,
        discordId?: string
    ): Promise<void> {
        try {
            let profile = this.userProfiles.get(userId);

            if (!profile) {
                // Create new profile
                profile = {
                    type: "user_profile",
                    id: stringToUuid(`profile-${userId}`),
                    text: `User profile for ${userId}`,
                    userId,
                    discordId,
                    walletAddresses: [walletAddress],
                    totalDeposits: [],
                    reputation: 0,
                    roles: ["member"],
                    votingPower: 0,
                    lastActive: Date.now(),
                    agentId: this.runtime.agentId,
                    status: "executed",
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
            } else {
                // Update existing profile
                if (!profile.walletAddresses.includes(walletAddress)) {
                    profile.walletAddresses.push(walletAddress);
                }
                if (discordId && !profile.discordId) {
                    profile.discordId = discordId;
                }
                profile.updatedAt = Date.now();
            }

            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error handling wallet registration:", error);
        }
    }

    private async handleDeposit(userId: UUID, deposit: TokenBalance): Promise<void> {
        try {
            const profile = this.userProfiles.get(userId);
            if (!profile) {
                elizaLogger.warn(`No profile found for user ${userId} during deposit`);
                return;
            }

            // Update total deposits
            const existingTokenIndex = profile.totalDeposits.findIndex(
                t => t.token === deposit.token
            );

            if (existingTokenIndex >= 0) {
                const existing = profile.totalDeposits[existingTokenIndex];
                profile.totalDeposits[existingTokenIndex] = {
                    ...existing,
                    amount: (BigInt(existing.amount) + BigInt(deposit.amount)).toString(),
                    usdValue: deposit.usdValue 
                        ? (Number(existing.usdValue || 0) + Number(deposit.usdValue)).toString()
                        : undefined
                };
            } else {
                profile.totalDeposits.push(deposit);
            }

            // Update reputation
            await this.updateReputation(userId, REPUTATION_SCORES.DEPOSIT, "Deposit made");

            // Update profile
            profile.updatedAt = Date.now();
            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error handling deposit:", error);
        }
    }

    private async updateUserActivity(
        userId: UUID,
        activityType: UserActivityLog["activityType"],
        details: Record<string, any>
    ): Promise<void> {
        try {
            // Log activity
            const activityLog: UserActivityLog = {
                type: "user_activity",
                id: stringToUuid(`activity-${Date.now()}`),
                userId,
                activityType,
                details,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                status: "executed",
                text: `User activity: ${activityType}`,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await this.runtime.messageManager.createMemory({
                id: activityLog.id,
                content: activityLog,
                roomId: ROOM_IDS.DAO,
                userId,
                agentId: this.runtime.agentId
            });

            // Update reputation based on activity
            const reputationScore = this.getReputationScoreForActivity(activityType);
            if (reputationScore > 0) {
                await this.updateReputation(userId, reputationScore, `${activityType} completed`);
            }

            // Update last active timestamp
            const profile = this.userProfiles.get(userId);
            if (profile) {
                profile.lastActive = Date.now();
                profile.updatedAt = Date.now();
                await this.updateProfile(profile);
            }
        } catch (error) {
            elizaLogger.error("Error updating user activity:", error);
        }
    }

    private getReputationScoreForActivity(activityType: string): number {
        switch (activityType) {
            case "deposit":
                return REPUTATION_SCORES.DEPOSIT;
            case "proposal":
                return REPUTATION_SCORES.PROPOSAL_CREATED;
            case "vote":
                return REPUTATION_SCORES.VOTE_CAST;
            case "strategy":
                return REPUTATION_SCORES.STRATEGY_SUCCESS;
            default:
                return 0;
        }
    }

    private async updateReputation(
        userId: UUID,
        points: number,
        reason: string
    ): Promise<void> {
        try {
            const profile = this.userProfiles.get(userId);
            if (!profile) return;

            const previousReputation = profile.reputation;
            profile.reputation += points;

            // Create reputation update record
            const reputationUpdate: UserReputationUpdate = {
                type: "reputation_update",
                id: stringToUuid(`rep-${Date.now()}`),
                userId,
                previousReputation,
                newReputation: profile.reputation,
                reason,
                timestamp: Date.now(),
                agentId: this.runtime.agentId,
                status: "executed",
                text: `Reputation updated: ${reason}`,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };

            await this.runtime.messageManager.createMemory({
                id: reputationUpdate.id,
                content: reputationUpdate,
                roomId: ROOM_IDS.DAO,
                userId,
                agentId: this.runtime.agentId
            });

            // Update voting power based on new reputation
            profile.votingPower = this.calculateVotingPower(profile);
            
            await this.updateProfile(profile);
        } catch (error) {
            elizaLogger.error("Error updating reputation:", error);
        }
    }

    private calculateVotingPower(profile: UserProfile): number {
        // Base voting power from reputation
        let power = Math.sqrt(profile.reputation);

        // Additional power from deposits (simplified)
        const totalUsdValue = profile.totalDeposits.reduce((sum, deposit) => {
            return sum + (deposit.usdValue ? Number(deposit.usdValue) : 0);
        }, 0);

        // Add deposit-based power (1 power per $100 deposited)
        power += totalUsdValue / 100;

        return Math.floor(power);
    }

    private async updateProfile(profile: UserProfile): Promise<void> {
        try {
            // Update local cache
            this.userProfiles.set(profile.userId, profile);

            // Create profile update memory
            const updateMemory: Memory = {
                id: stringToUuid(`profile-update-${Date.now()}`),
                content: profile,
                roomId: ROOM_IDS.DAO,
                userId: profile.userId,
                agentId: this.runtime.agentId
            };

            await this.runtime.messageManager.createMemory(updateMemory);
        } catch (error) {
            elizaLogger.error("Error updating user profile:", error);
        }
    }

    public async getUserProfile(userId: UUID): Promise<UserProfile | null> {
        const profiles = await this.runtime.messageManager.getMemories({
            roomId: this.runtime.agentId,
            count: 1
        });
        
        const profile = profiles.find(p => 
            p.content.type === "user_profile" && 
            (p.content as UserProfile).userId === userId
        );

        return profile ? profile.content as UserProfile : null;
    }

    public async getUserByWallet(walletAddress: string): Promise<UserProfile | undefined> {
        for (const profile of this.userProfiles.values()) {
            if (profile.walletAddresses.includes(walletAddress)) {
                return profile;
            }
        }
        return undefined;
    }

    public async getUserByDiscordId(discordId: string): Promise<UserProfile | undefined> {
        for (const profile of this.userProfiles.values()) {
            if (profile.discordId === discordId) {
                return profile;
            }
        }
        return undefined;
    }

    public async validateAction(content: BaseContent): Promise<boolean> {
        return true; // Add specific validation if needed
    }

    public async executeAction(content: BaseContent): Promise<boolean> {
        return true; // Add specific action execution if needed
    }

    protected async processMemory(memory: Memory): Promise<void> {
        // Add memory processing logic if needed
    }

    public async isActive(): Promise<boolean> {
        try {
            // Check if agent state is active in the database
            const state = await this.runtime.messageManager.getMemories({
                roomId: ROOM_IDS.DAO,
                count: 1
            });

            const agentState = state.find(memory => 
                memory.content.type === "agent_state" &&
                memory.content.agentId === this.id
            );

            return agentState?.content.status === "active";
        } catch (error) {
            elizaLogger.error("Error checking UserProfileAgent state:", error);
            return false;
        }
    }

    private async handleNewProposal(proposerId: UUID, proposalId: string): Promise<void> {
        try {
            // Get user profile
            const userProfile = await this.getUserProfile(proposerId) as UserProfile | null;
            if (!userProfile) {
                elizaLogger.warn(`No user profile found for proposer ${proposerId}`);
                return;
            }

            // Update user's proposal count
            const updatedProfile: UserProfile = {
                ...userProfile,
                proposalsCreated: (userProfile.proposalsCreated as number) + 1,
                lastActive: Date.now(),
                metadata: {
                    ...userProfile.metadata,
                    proposalId: proposalId,
                    userStats: {
                        proposalsCreated: (userProfile.proposalsCreated as number) + 1,
                        votesCount: userProfile.votesCount as number
                    }
                }
            };

            // Store updated profile
            await this.createMemory(updatedProfile);

            elizaLogger.info(`Updated user profile for new proposal`, {
                userId: proposerId,
                proposalId,
                newProposalCount: updatedProfile.proposalsCreated
            });
        } catch (error) {
            elizaLogger.error(`Error handling new proposal for user ${proposerId}:`, error);
        }
    }

    protected subscribeToMemory(type: string, callback: (memory: Memory) => Promise<void>): void {
        super.subscribeToMemory(type, callback);
    }

    protected async handleMemory(memory: Memory): Promise<void> {
        if (memory.content.type === "user_profile") {
            await this.handleProfileUpdate(memory);
        }
    }

    protected loadActions(): void {
        // No specific actions to load for user profile agent
    }

    protected async setupCrossProcessEvents(): Promise<void> {
        // Subscribe to profile updates from other processes
        this.messageBroker.subscribe("user_profile_updated", async (event) => {
            await this.handleProfileUpdate(event);
        });
    }
} 