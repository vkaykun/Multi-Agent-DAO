// packages/plugin-solana/src/startVela.ts

import { elizaLogger, AgentRuntime, ModelProviderName, stringToUuid } from "@elizaos/core";
import { DiscordClientInterface } from '../../client-discord';
import { DirectClientInterface } from '../../client-direct';
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig";
import { getProcessDatabase } from "./shared/database";
import { AGENT_IDS } from './shared/constants';
import { MemorySyncManager } from './shared/memory/MemorySyncManager';
import { MessageBroker } from './shared/MessageBroker';
import { IAgentRuntime } from './shared/types/base';
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { EventEmitter } from "events";

// Load Vela-specific environment variables
dotenv.config({ path: path.join(__dirname, "../.env.vela") });

async function startVela() {
  // 1. Parse and validate database config
  const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
  
  // Initialize memory sync manager early
  const memorySyncManager = MemorySyncManager.getInstance();
  memorySyncManager.onMemorySynced((memory) => {
    elizaLogger.debug('Memory synced:', memory.id);
  });

  // Create temporary runtime for database initialization
  const tempRuntime = new AgentRuntime({
    agentId: stringToUuid("vela-temp"),
    token: process.env.DISCORD_API_TOKEN || "",
    modelProvider: ModelProviderName.OPENAI,
    databaseAdapter: null,
    cacheManager: null
  });
  const db = await getProcessDatabase(tempRuntime, "vela");

  // 2. Load the Vela character file
  const velaCharacterPath = path.join(__dirname, "../../../characters/vela.character.json");
  const velaCharacter = JSON.parse(fs.readFileSync(velaCharacterPath, "utf-8"));

  // 3. Create an AgentRuntime (single process mode)
  const isMultiProcess = process.env.MULTI_PROCESS === "true";
  const plugins = velaCharacter.plugins || [];

  const runtimeConfig = {
    agentId: AGENT_IDS.TREASURY,
    character: {
      ...velaCharacter,
      settings: {
        ...velaCharacter.settings,
        SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
        proposalQuorum: process.env.PROPOSAL_QUORUM,
        proposalMinimumYesVotes: process.env.PROPOSAL_MINIMUM_YES_VOTES,
        proposalMinimumVotePercentage: process.env.PROPOSAL_MINIMUM_VOTE_PERCENTAGE,
        maxProposalsPerUser: process.env.MAX_PROPOSALS_PER_USER,
        proposalExpiryDays: process.env.PROPOSAL_EXPIRY_DAYS
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

  // 5. Start the Vela agent
  const { TreasuryAgent } = await import("./agents/treasury/TreasuryAgent");
  const velaAgent = new TreasuryAgent(runtimeWithEvents);
  await velaAgent.initialize();

  elizaLogger.info(`Vela agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
    databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
    maxConnections: dbConfig.maxConnections || 1,
    clients: process.env.DISCORD_API_TOKEN ? ['Discord', 'Direct'] : ['Direct'],
    memorySync: 'enabled'
  });
}

// Run
startVela().catch((error) => {
  elizaLogger.error("Failed to start Vela:", error);
  process.exit(1);
}); 