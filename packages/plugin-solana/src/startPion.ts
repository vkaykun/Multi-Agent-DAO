import { elizaLogger, AgentRuntime, ModelProviderName, stringToUuid } from "@elizaos/core";
import { DiscordClientInterface } from '../../client-discord';
import { DirectClientInterface } from '../../client-direct';
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig";
import { getProcessDatabase } from "./shared/database";
import { AGENT_IDS } from './shared/constants';
import { IMemoryManager, IAgentRuntime } from './shared/types/base';
import { MemorySyncManager } from './shared/memory/MemorySyncManager';
import { MessageBroker } from './shared/MessageBroker';
import path from 'path';
import fs from 'fs';
import dotenv from "dotenv";
import { EventEmitter } from 'events';

// Load Pion-specific environment variables
dotenv.config({ path: path.join(__dirname, "../.env.pion") });

async function startPion() {
    // 1. Parse and validate database config
    const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
    
    // Initialize memory sync manager early
    const memorySyncManager = MemorySyncManager.getInstance();
    memorySyncManager.onMemorySynced((memory) => {
        elizaLogger.debug('Memory synced:', memory.id);
    });

    // Create temporary runtime for database initialization
    const tempRuntime = new AgentRuntime({
        agentId: stringToUuid("pion-temp"),
        token: process.env.DISCORD_API_TOKEN || "",
        modelProvider: ModelProviderName.OPENAI,
        databaseAdapter: null,
        cacheManager: null
    });
    const db = await getProcessDatabase(tempRuntime, "pion");

    // 2. Load the Pion character file
    const pionCharacterPath = path.join(__dirname, "../../../characters/pion.character.json");
    const pionCharacter = JSON.parse(fs.readFileSync(pionCharacterPath, 'utf-8'));

    // 3. Create an AgentRuntime (single process mode)
    const isMultiProcess = process.env.MULTI_PROCESS === "true";
    const plugins = pionCharacter.plugins || [];

    const runtimeConfig = {
        agentId: AGENT_IDS.PROPOSAL,
        character: {
            ...pionCharacter,
            settings: {
                ...pionCharacter.settings,
                SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                quorumThreshold: process.env.QUORUM_THRESHOLD,
                votingPeriod: process.env.VOTING_PERIOD,
                minimumVotes: process.env.MINIMUM_VOTES,
                proposalTypes: process.env.PROPOSAL_TYPES?.split(',') || ["strategy", "swap", "governance", "parameter_change"]
            }
        },
        token: process.env.DISCORD_API_TOKEN || "",
        modelProvider: ModelProviderName.OPENAI,
        databaseAdapter: db.adapter,
        cacheManager: db.cache,
        multiProcess: isMultiProcess,
        plugins: plugins
    };

    const runtime = new AgentRuntime(runtimeConfig);
    await runtime.initialize();

    // Initialize message broker for inter-process communication
    const messageBroker = MessageBroker.getInstance();
    messageBroker.subscribe('memory_event', (event) => {
        elizaLogger.debug('Memory event received:', event.type);
    });

    // Cast runtime to include event methods
    const runtimeWithEvents = runtime as unknown as IAgentRuntime;

    // 4. Set up clients
    if (process.env.DISCORD_API_TOKEN) {
        await DiscordClientInterface.start(runtimeWithEvents);
    }
    await DirectClientInterface.start(runtimeWithEvents);

    // 5. Start the Pion agent
    const { ProposalAgent } = await import("./agents/proposal/ProposalAgent");
    const pionAgent = new ProposalAgent(runtimeWithEvents);
    await pionAgent.initialize();

    elizaLogger.info(`Pion agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
        databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
        maxConnections: dbConfig.maxConnections || 1,
        clients: process.env.DISCORD_API_TOKEN ? ['Discord', 'Direct'] : ['Direct'],
        memorySync: 'enabled'
    });
}

// Run
startPion().catch((error) => {
    elizaLogger.error("Failed to start Pion:", error);
    process.exit(1);
}); 