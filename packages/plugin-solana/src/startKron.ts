import { 
    AgentRuntime, 
    CacheManager, 
    elizaLogger, 
    MemoryCacheAdapter, 
    ModelProviderName, 
    stringToUuid,
    Action 
} from '@elizaos/core';
import { DiscordClientInterface } from '../../client-discord';
import { DirectClientInterface } from '../../client-direct';
import path from 'path';
import fs from 'fs';
import dotenv from "dotenv";
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig";
import { getProcessDatabase } from "./shared/database";
import { AGENT_IDS } from './shared/constants';
import { MemorySyncManager } from './shared/memory/MemorySyncManager';
import { MessageBroker } from './shared/MessageBroker';

// Load Kron-specific environment variables
dotenv.config({ path: path.join(__dirname, "../.env.kron") });

async function startKron() {
    // 1. Parse and validate database config
    const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
    
    // Initialize memory sync manager early
    const memorySyncManager = MemorySyncManager.getInstance();
    memorySyncManager.onMemorySynced((memory) => {
        elizaLogger.debug('Memory synced:', memory.id);
    });

    // Create temporary runtime for database initialization
    const tempRuntime = new AgentRuntime({
        agentId: stringToUuid("kron-temp"),
        token: process.env.DISCORD_API_TOKEN || "",
        modelProvider: ModelProviderName.OPENAI,
        databaseAdapter: null,
        cacheManager: null
    });
    const db = await getProcessDatabase(tempRuntime, "kron");

    // 2. Load the Kron character file
    const kronCharacterPath = path.join(__dirname, "../../../characters/kron.character.json");
    const kronCharacter = JSON.parse(fs.readFileSync(kronCharacterPath, "utf-8"));

    // 3. Create an AgentRuntime (single process mode)
    const isMultiProcess = process.env.MULTI_PROCESS === "true";
    const plugins = kronCharacter.plugins || [];

    const runtimeConfig = {
        agentId: AGENT_IDS.STRATEGY,
        character: {
            ...kronCharacter,
            settings: {
                ...kronCharacter.settings,
                SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                maxPositionSize: process.env.MAX_POSITION_SIZE,
                maxDrawdown: process.env.MAX_DRAWDOWN,
                riskLevel: process.env.RISK_LEVEL,
                tradingPairs: process.env.TRADING_PAIRS?.split(',') || []
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

    // Create Solana runtime wrapper
    const { createSolanaRuntime } = await import("./shared/utils/runtime");
    const solanaRuntime = await createSolanaRuntime(runtime);

    // 4. Set up clients
    if (process.env.DISCORD_API_TOKEN) {
        await DiscordClientInterface.start(runtime);
    }
    await DirectClientInterface.start(runtime);

    // 5. Start the Kron agent
    const { StrategyAgent } = await import("./agents/strategy/StrategyAgent");
    const kronAgent = new StrategyAgent(solanaRuntime);
    await kronAgent.initialize();

    elizaLogger.info(`Kron agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
        databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
        maxConnections: dbConfig.maxConnections || 1,
        clients: process.env.DISCORD_API_TOKEN ? ['Discord', 'Direct'] : ['Direct'],
        memorySync: 'enabled'
    });

    return kronAgent;
}

// Run
startKron().catch((error) => {
    elizaLogger.error("Failed to start Kron:", error);
    process.exit(1);
}); 