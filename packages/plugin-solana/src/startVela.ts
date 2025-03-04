// packages/plugin-solana/src/startVela.ts

import { elizaLogger, AgentRuntime, ModelProviderName, stringToUuid, IMemoryManager, MemoryManager, UUID, Memory } from "@elizaos/core";
import { DiscordClientInterface } from '@elizaos/client-discord';
import { DirectClientInterface } from '@elizaos/client-direct';
import { DatabaseConfigValidator } from "./shared/utils/databaseConfig.ts";
import { getProcessDatabase } from "./shared/database.ts";
import { AGENT_IDS } from './shared/constants.ts';
import { MemorySyncManager } from './shared/memory/MemorySyncManager.ts';
import { MessageBroker } from './shared/MessageBroker.ts';
import { IAgentRuntime } from './shared/types/base.ts';
import { createSolanaRuntime, ExtendedMemoryManager } from './shared/utils/runtime.ts';
import { MemoryManager as MemoryManagerImport } from './shared/memory/index.ts';
import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PostgresDatabaseAdapter } from '@elizaos/adapter-postgres';
import { IDatabaseAdapter } from '@elizaos/core';
import { applyRuntimeFixes } from './shared/fixes/bypass.js';
import './shared/fixes/runtime-injector.js'; 
import { applyAggressiveVectorFix } from './shared/fixes/vector-fix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load mainenvironment variables
dotenv.config({ path: path.join(__dirname, "../../../.env") });
elizaLogger.info("Loaded main .env file");

elizaLogger.info("Environment after main .env:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

// Vela-specific environment
const velaEnvPath = path.join(__dirname, "..", ".env.vela");
elizaLogger.info("Loading .env.vela from:", velaEnvPath);
elizaLogger.info("File exists check:", fs.existsSync(velaEnvPath));
const velaEnvResult = dotenv.config({ path: velaEnvPath, override: true });
elizaLogger.info("Vela env loading result:", {
    error: velaEnvResult.error?.message,
    parsed: velaEnvResult.parsed ? Object.keys(velaEnvResult.parsed) : null
});

elizaLogger.info("Final environment state:", {
    DISCORD_TOKEN: process.env.DISCORD_API_TOKEN ? "Present" : "Missing",
    DISCORD_APP_ID: process.env.DISCORD_APPLICATION_ID ? "Present" : "Missing",
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY ? "Present" : "Missing",
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ? "Present" : "Missing"
});

if (velaEnvResult.error) {
    elizaLogger.error("Error loading .env.vela:", velaEnvResult.error);
} else {
    elizaLogger.info("Successfully loaded .env.vela");
}

elizaLogger.info("All available environment variables:", {
    keys: Object.keys(process.env),
    discordRelated: Object.keys(process.env).filter(key => key.toLowerCase().includes('discord'))
});

elizaLogger.info("Environment variables after loading:", {
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    BASE_MINT: process.env.BASE_MINT,
    NODE_ENV: process.env.NODE_ENV
});


process.on('unhandledRejection', (reason, promise) => {
    elizaLogger.error('Unhandled Rejection at:', {
        reason: reason instanceof Error ? {
            message: reason.message,
            stack: reason.stack,
            name: reason.name
        } : reason,
        reasonStr: String(reason)
    });
});

export async function startVela(): Promise<{ vela: any; solanaRuntime: any }> {
  let solanaRuntime = null;
  let velaAgent = null;
  
  try {
    elizaLogger.info("Starting Vela (Treasury Agent)");
    elizaLogger.info("Runtime environment:", {
      databaseUrl: process.env.DATABASE_URL || "not set",
      multiProcess: process.env.MULTI_PROCESS === 'true',
      NODE_ENV: process.env.NODE_ENV,
      embeddingModel: process.env.EMBEDDING_OPENAI_MODEL
    });

    elizaLogger.info("🧩 Initializing runtime fixes from startVela");
    if (global.__solana_apply_fixes) {
      elizaLogger.info("🔧 Global fixup function found");
    } else {
      elizaLogger.warn("⚠️ Global fixup function not found, loading directly");
    }

    try {
      elizaLogger.info("Starting Vela initialization...");
      
      // 1) Database config
      elizaLogger.info("Parsing database config...");
      const dbConfig = await DatabaseConfigValidator.getInstance().getDatabaseConfig();
      elizaLogger.info("Database config parsed successfully");

      // Memory sync manager
      elizaLogger.info("Initializing memory sync manager...");
      const memorySyncManager = MemorySyncManager.getInstance();
      memorySyncManager.onMemorySynced(async (memory) => {
        elizaLogger.debug('Memory synced:', memory.id);
      });
      elizaLogger.info("Memory sync manager initialized");

      // Initialize DB
      let db;
      try {
        elizaLogger.info("Initializing PostgreSQL adapter...");
        const postgresAdapter = new PostgresDatabaseAdapter({
          connectionString: dbConfig.url,
          max: 20
        });

        // Wrap transaction methods
        const adapterWithTransactions = Object.assign(postgresAdapter, {
          beginTransaction: async function() {
            return this.query('BEGIN');
          },
          commitTransaction: async function() {
            return this.query('COMMIT');
          },
          rollbackTransaction: async function() {
            return this.query('ROLLBACK');
          }
        });

        let adapter = adapterWithTransactions as unknown as IDatabaseAdapter;
        elizaLogger.info("PostgreSQL adapter initialized successfully");

        db = await getProcessDatabase({
          messageManager: {
            onMemoryCreated: () => {},
            onMemoryUpdated: () => {},
            onMemoryDeleted: () => {},
          },
          adapter: adapter
        } as any, "vela");
        elizaLogger.info("Database initialized successfully");

      } catch (error) {
        elizaLogger.error("Failed to initialize database:", {
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      // 2) Create initial runtime for memory manager
      elizaLogger.info("Creating initial runtime...");
      const initRuntime = new AgentRuntime({
        agentId: stringToUuid("vela-temp"),
        token: process.env.OPENAI_API_KEY || "",
        modelProvider: ModelProviderName.OPENAI,
        databaseAdapter: db.adapter,
        cacheManager: db.adapter.getCacheManager ? db.adapter.getCacheManager() : db.adapter
      });
      elizaLogger.info("Initial runtime created");

      // Extended memory manager
      elizaLogger.info("Creating memory manager...");
      class ExtendedBaseMemoryManager extends MemoryManagerImport {
        private _transactionLevel: number = 0;

        async getMemoriesWithLock(query: any) {
            return this.getMemories(query);
        }
        async getMemoryWithLock(id: UUID) {
            return this.getMemory(id);
        }
        get isInTransaction(): boolean {
            return this._transactionLevel > 0;
        }
        getTransactionLevel(): number {
            return this._transactionLevel;
        }
        async beginTransaction(): Promise<void> {
            this._transactionLevel++;
        }
        async commitTransaction(): Promise<void> {
            this._transactionLevel = Math.max(0, this._transactionLevel - 1);
        }
        async rollbackTransaction(): Promise<void> {
            this._transactionLevel = Math.max(0, this._transactionLevel - 1);
        }
        async removeMemoriesWhere(condition: any) {
            elizaLogger.warn('removeMemoriesWhere not fully implemented in base manager');
            return Promise.resolve();
        }
        
        async getMemoriesWithFilters(options: { 
            domain: UUID; 
            count?: number; 
            filter?: Record<string, any>;
            sort?: { field: string; direction: 'asc' | 'desc' }[];
        }): Promise<Memory[]> {
            elizaLogger.info(`[ExtendedBaseMemoryManager] Using getMemoriesWithFilters with domain: ${options.domain}`);
            
            const { domain, count = 10, filter = {}, sort = [] } = options;
            
            const memories = await this.getMemories({
                roomId: domain,
                count: count * 3,
            });
            
            let filteredMemories = memories;
            if (filter && Object.keys(filter).length > 0) {
                elizaLogger.debug(`[ExtendedBaseMemoryManager] Filtering ${memories.length} memories with filter:`, filter);
                filteredMemories = memories.filter(memory => {
                    return Object.entries(filter).every(([key, value]) => {
                        // Handle object values in content
                        if (key.startsWith('content.') && memory.content) {
                            const contentKey = key.split('.')[1];
                            return memory.content[contentKey] === value;
                        }
                        return memory[key] === value;
                    });
                });
            }
            
            if (sort.length > 0) {
                elizaLogger.debug(`[ExtendedBaseMemoryManager] Sorting ${filteredMemories.length} memories`);
                filteredMemories.sort((a, b) => {
                    for (const { field, direction } of sort) {
                        // Handle object values in content
                        if (field.startsWith('content.') && a.content && b.content) {
                            const contentKey = field.split('.')[1];
                            const aValue = a.content[contentKey];
                            const bValue = b.content[contentKey];
                            
                            if (aValue < bValue) return direction === 'asc' ? -1 : 1;
                            if (aValue > bValue) return direction === 'asc' ? 1 : -1;
                        } else {
                            if (a[field] < b[field]) return direction === 'asc' ? -1 : 1;
                            if (a[field] > b[field]) return direction === 'asc' ? 1 : -1;
                        }
                    }
                    return 0;
                });
            }
            
            const result = filteredMemories.slice(0, count);
            elizaLogger.info(`[ExtendedBaseMemoryManager] Filtered from ${memories.length} to ${filteredMemories.length} memories, returning ${result.length}`);
            
            return result;
        }
      }

      const memoryManager = new ExtendedBaseMemoryManager({
        runtime: initRuntime,
        tableName: "messages",
        adapter: db.adapter
      });
      await memoryManager.initialize();
      elizaLogger.info("Memory manager initialized");

      elizaLogger.info("Creating extended memory manager...");
      const extendedMemoryManager = new ExtendedMemoryManager(
        memoryManager,
        new Map()
      );
      await extendedMemoryManager.initialize();
      elizaLogger.info("Extended memory manager created");

      // 3) Load Vela character file
      elizaLogger.info("Loading Vela character file...");
      const velaCharacterPath = path.join(__dirname, "../../../characters/vela.character.json");
      if (!fs.existsSync(velaCharacterPath)) {
        throw new Error(`Character file not found at: ${velaCharacterPath}. Please ensure the file exists.`);
      }

      let velaCharacter;
      try {
        const characterContent = fs.readFileSync(velaCharacterPath, "utf-8");
        velaCharacter = JSON.parse(characterContent);
        elizaLogger.info("Vela character file loaded successfully");
      } catch (error) {
        elizaLogger.error("Failed to load character file:", error);
        throw new Error(`Failed to load character file: ${error.message}`);
      }

      if (!velaCharacter || typeof velaCharacter !== 'object') {
        throw new Error('Invalid character file format. Expected a JSON object.');
      }

      // 4) Create agent runtime config
      elizaLogger.info("Creating agent runtime...");
      const isMultiProcess = process.env.MULTI_PROCESS === "true";
      const plugins = velaCharacter.plugins || [];

      // Debug log the velaCharacter
      elizaLogger.debug("Vela character content:", {
          hasAgentConfig: !!velaCharacter.agentConfig,
          hasSettings: !!velaCharacter.settings,
          content: velaCharacter
      });

      // Create base character config
      const characterConfig = {
          name: "Vela",
          modelProvider: velaCharacter.modelProvider || "openai",
          bio: velaCharacter.bio || "",
          lore: velaCharacter.lore || "",
          messageExamples: velaCharacter.messageExamples || [],
          messageDirections: velaCharacter.messageDirections || "",
          postDirections: velaCharacter.postDirections || "",
          postExamples: velaCharacter.postExamples || [],
          topics: velaCharacter.topics || [],
          adjectives: velaCharacter.adjectives || [],
          style: velaCharacter.style || { all: [], chat: [], post: [] },
          clients: velaCharacter.clients || {},
          agentConfig: {
              type: "TREASURY" as const,
              capabilities: [],
              permissions: [],
              settings: {
                  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
                  proposalQuorum: process.env.PROPOSAL_QUORUM,
                  proposalMinimumYesVotes: process.env.PROPOSAL_MINIMUM_YES_VOTES,
                  proposalMinimumVotePercentage: process.env.PROPOSAL_MINIMUM_VOTE_PERCENTAGE,
                  maxProposalsPerUser: process.env.MAX_PROPOSALS_PER_USER,
                  proposalExpiryDays: process.env.PROPOSAL_EXPIRY_DAYS
              }
          },
          settings: velaCharacter.settings || {},
          templates: velaCharacter.templates || {},
          clientConfig: {
              discord: {
                  shouldRespondOnlyToMentions: false,
                  shouldIgnoreBotMessages: true,
                  messageSimilarityThreshold: 0.7
              },
              ...velaCharacter.clientConfig
          },
          plugins: plugins
      };

      // Debug log the character config
      elizaLogger.debug("Character config:", {
          hasAgentConfig: !!characterConfig.agentConfig,
          agentConfigType: characterConfig.agentConfig?.type,
          settings: characterConfig.settings,
          clientConfig: characterConfig.clientConfig
      });

      const runtimeConfig = {
          agentId: AGENT_IDS.TREASURY,
          agentType: "TREASURY" as const,
          character: characterConfig,
          token: process.env.OPENAI_API_KEY || "",
          modelProvider: ModelProviderName.OPENAI,
          databaseAdapter: db.adapter,
          cacheManager: db.adapter.getCacheManager ? db.adapter.getCacheManager() : db.adapter,
          multiProcess: isMultiProcess,
          plugins: plugins,
          messageManager: extendedMemoryManager,
          documentsManager: extendedMemoryManager,
          knowledgeManager: extendedMemoryManager,
          metadata: {
              agentType: "TREASURY" as const,
              settings: characterConfig.settings,
              clientConfig: characterConfig.clientConfig
          }
      };

      // Debug log the runtime config
      elizaLogger.debug("Runtime config:", {
          hasCharacter: !!runtimeConfig.character,
          hasAgentConfig: !!runtimeConfig.character?.agentConfig,
          characterContent: JSON.stringify(runtimeConfig.character, null, 2)
      });

      elizaLogger.info("Creating AgentRuntime...");
      const runtime = new AgentRuntime(runtimeConfig);
      elizaLogger.info("AgentRuntime created successfully");

      elizaLogger.info("Initializing runtime...");
      await runtime.initialize();
      elizaLogger.info("Runtime initialized successfully");

      // 5) Create Solana runtime
      elizaLogger.info("Creating Solana runtime...");
      elizaLogger.debug("Creating Solana runtime with config:", {
          agentType: runtimeConfig.agentType,
          hasCharacter: !!runtimeConfig.character,
          hasAgentConfig: !!runtimeConfig.character?.agentConfig,
          characterContent: JSON.stringify(runtimeConfig.character, null, 2)
      });
      const solanaRuntimeConfig = {
        ...runtimeConfig,
        character: {
          ...runtimeConfig.character,
          agentConfig: {
            ...runtimeConfig.character.agentConfig,
            type: "TREASURY"
          }
        },
        agentType: "TREASURY" as const,
        messageManager: extendedMemoryManager,
        descriptionManager: extendedMemoryManager,
        documentsManager: extendedMemoryManager,
        knowledgeManager: extendedMemoryManager,
        loreManager: extendedMemoryManager
      };
      solanaRuntime = await createSolanaRuntime(solanaRuntimeConfig);
      elizaLogger.info("Solana runtime created");

      // Initialize clients
      solanaRuntime.clients = {};

      // Initialize Discord client if token is available
      if (process.env.DISCORD_API_TOKEN) {
        try {
          // Use the solanaRuntime directly which already has registerAction method
          const discordClient = await DiscordClientInterface.start(solanaRuntime);
          solanaRuntime.clients.discord = discordClient;
          elizaLogger.info("Discord client started successfully");
        } catch (error) {
          elizaLogger.error("Failed to start Discord client:", {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
          });
        }
      } else {
        elizaLogger.warn("Discord client not initialized - DISCORD_API_TOKEN not found in environment");
      }

      // Start Direct client
      const directClient = await DirectClientInterface.start(solanaRuntime);
      solanaRuntime.clients.direct = directClient;
      elizaLogger.info("Direct client started");

      // 8) Start the Vela agent
      elizaLogger.info("Starting Vela agent...");
      try {
        const { TreasuryAgent } = await import("./agents/treasury/TreasuryAgent.ts").catch(importError => {
          // Safe error logging without object to string conversion
          elizaLogger.error("Error importing TreasuryAgent:", {
            message: importError instanceof Error ? importError.message : 'Non-error object thrown',
            name: importError instanceof Error ? importError.name : 'Unknown',
            stack: importError instanceof Error ? importError.stack : undefined
          });
          throw new Error("Failed to import TreasuryAgent module");
        });
        
        try {
          // Create and initialize TreasuryAgent
          velaAgent = new TreasuryAgent(solanaRuntime);
          elizaLogger.info("Vela agent created, now initializing...");
          
          await velaAgent.initialize().catch(initError => {
            // Safe error logging without object to string conversion
            elizaLogger.error("Error initializing Vela agent:", {
              message: initError instanceof Error ? initError.message : 'Non-error object thrown',
              name: initError instanceof Error ? initError.name : 'Unknown',
              stack: initError instanceof Error ? initError.stack : undefined
            });
            throw new Error("Failed to initialize Vela agent");
          });
          
          elizaLogger.info("Vela agent initialized successfully");
        } catch (agentError) {
          // Safe error logging without object to string conversion
          elizaLogger.error("Error creating or initializing Vela agent:", {
            message: agentError instanceof Error ? agentError.message : 'Non-error object thrown',
            name: agentError instanceof Error ? agentError.name : 'Unknown',
            stack: agentError instanceof Error ? agentError.stack : undefined
          });
          throw new Error("Failed to create or initialize Vela agent");
        }
      } catch (importError) {
        // Safe error logging without object to string conversion
        elizaLogger.error("Error importing TreasuryAgent module:", {
          message: importError instanceof Error ? importError.message : 'Non-error object thrown',
          name: importError instanceof Error ? importError.name : 'Unknown',
          stack: importError instanceof Error ? importError.stack : undefined
        });
        throw new Error("Failed to start TreasuryAgent due to import or initialization error");
      }

      elizaLogger.info(`Vela agent running in ${isMultiProcess ? 'multi' : 'single'} process mode:`, {
        databaseUrl: dbConfig.url.replace(/\/\/.*@/, "//***@"),
        maxConnections: dbConfig.maxConnections || 1,
        clients: process.env.DISCORD_API_TOKEN ? ['Direct'] : ['Direct'],
        memorySync: 'enabled'
      });

      // Apply runtime fixes
      elizaLogger.info("🔄 Applying runtime fixes...");
      const fixesApplied = applyRuntimeFixes(solanaRuntime as any);
      elizaLogger.info(`🔧 Runtime fixes ${fixesApplied ? "applied successfully" : "failed to apply"}`);
      
      // Apply our aggressive vector fix
      elizaLogger.info("🧩 Applying aggressive vector dimension fix...");
      const vectorFixApplied = applyAggressiveVectorFix(solanaRuntime as any);
      elizaLogger.info(`🧬 Vector dimension fix ${vectorFixApplied ? "applied successfully" : "failed to apply"}`);

      // Store in global for other modules to access
      try {
        (global as any).solanaRuntime = solanaRuntime;
        elizaLogger.info("Set global.solanaRuntime reference");
        
        if ((global as any).__plugin_solana_runtime_hook) {
          elizaLogger.info("Calling global runtime hook");
          (global as any).__plugin_solana_runtime_hook(solanaRuntime);
        }
      } catch (globalError) {
        elizaLogger.error("Error setting global references:", globalError);
        // Continue without global references
      }

      return { vela: velaAgent, solanaRuntime };
    } catch (error) {
      elizaLogger.error("Error in startVela:", {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
          cause: error.cause ? (typeof error.cause === 'string' ? error.cause : 
                 (error.cause instanceof Error ? error.cause.message : 'Complex cause object')) : undefined
        } : error,
        code: error.code,
        statusCode: error.statusCode,
        type: error.type,
        errorSummary: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });
      throw new Error(`Failed to start Vela: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } catch (outerError) {
    elizaLogger.error("Fatal error in startVela:", {
      error: outerError instanceof Error ? {
        message: outerError.message,
        stack: outerError.stack,
        name: outerError.name
      } : outerError,
      errorSummary: outerError instanceof Error ? `${outerError.name}: ${outerError.message}` : String(outerError)
    });
    // Re-throw for the caller to handle
    throw outerError;
  }
}

// Finally run
startVela().catch((error) => {
  elizaLogger.error("Failed to start Vela:", {
    error: error instanceof Error ? {
      message: error.message,
      stack: error.stack,
      name: error.name,
      cause: error.cause ? (typeof error.cause === 'string' ? error.cause : 
             (error.cause instanceof Error ? error.cause.message : 'Complex cause object')) : undefined
    } : error,
    code: error.code,
    statusCode: error.statusCode,
    type: error.type,
    errorSummary: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  });
  process.exit(1);
});
