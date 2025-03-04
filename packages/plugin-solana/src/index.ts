// packages/plugin-solana/src/index.ts

export * from "./providers/token.ts";
export * from "./providers/wallet.ts";
export * from "./evaluators/trust.ts";
export * from "./agents/proposal/ProposalAgent.ts";
export * from "./shared/utils/runtime.ts";

// Import and re-export types from base and strategy
import { 
    AgentType,
    AgentMessage,
    BaseContent,
    CharacterName,
    CHARACTER_AGENT_MAPPING,
    TransactionOptions,
    DistributedLock,
    ServiceType,
    IAgentRuntime,
    IMemoryManager,
    AgentAction
} from "./shared/types/base.ts";
import { StrategyContent } from "./shared/types/strategy.ts";

export {
    AgentType,
    AgentMessage,
    BaseContent,
    CharacterName,
    CHARACTER_AGENT_MAPPING,
    StrategyContent,
    TransactionOptions,
    DistributedLock,
    ServiceType,
    IAgentRuntime,
    IMemoryManager,
    AgentAction
};

import { Plugin } from "@elizaos/core";
import { stringToUuid, UUID, Memory, State, HandlerCallback, Validator } from "@elizaos/core";
// Import elizaLogger from a different source to avoid duplicate identifiers
import { elizaLogger } from "@elizaos/core";
import { TokenProvider } from "./providers/token.ts";
import { WalletProvider } from "./providers/wallet.ts";
import { getTokenBalance, getTokenBalances } from "./providers/tokenUtils.ts";
import { walletProvider } from "./providers/wallet.ts";

// Comment out action handler imports since we're using agents
// import { register } from "./actions/register.js";
// import { deposit } from "./actions/deposit.js";
// import { balance } from "./actions/balance.js";
// import { verify } from "./actions/verify.js";
// import { executeSwap } from "./actions/swap.js";
// import transfer from "./actions/transfer.js";
// import { tokeninfo } from "./actions/tokeninfo.js";
// import { propose } from "./actions/propose.js";
// import { vote } from "./actions/vote.js";
// import { closeVote, startProposalMonitoring } from "./actions/closeVote.js";
// import cancelStrategy from "./actions/cancelStrategy.js";
// import { checkProposalStatus } from "./actions/checkProposalStatus.js";
// import { createAndBuyToken, buyPumpToken, CreateAndBuyContent, isCreateAndBuyContent } from "./actions/pumpfun.js";
// import { strategy } from "./actions/strategy.js";

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { BaseAgent } from "./shared/BaseAgent.ts";
import { MessageBroker } from './shared/MessageBroker.ts';
import { PumpFunSDK } from "pumpdotfun-sdk";
import { applyRuntimeFixes } from "./shared/fixes/bypass.js";
import { validateEmbeddingModel } from "./shared/utils/runtime.ts";
import { validateEmbeddingConfiguration } from "./shared/utils/embedding-validator";
import { patchMemoryManagerForConsistentEmbeddings } from "./shared/utils/embedding-helpers";
import { safelyApplyFixes } from "./shared/fixes/index.ts";

const require = createRequire(import.meta.url);

// Track if fixes have been applied successfully globally
let fixesApplied = false;

// Export core functionality
export {
    TokenProvider,
    WalletProvider,
    getTokenBalance,
    getTokenBalances,
    walletProvider,
    BaseAgent
};

// Comment out action handler exports since we're using agents
// export {
//     register,
//     deposit,
//     balance,
//     verify,
//     executeSwap,
//     transfer,
//     tokeninfo,
//     propose,
//     vote,
//     closeVote,
//     startProposalMonitoring,
//     cancelStrategy,
//     checkProposalStatus,
//     createAndBuyToken,
//     buyPumpToken,
//     strategy
// };

// Export constants and utilities
export {
    MessageBroker
};

/**
 * Validates if a string is a valid Solana address
 */
export function validateSolanaAddress(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch (e) {
        return false;
    }
}

// Solana plugin definition
export const solanaPlugin: Plugin = {
    name: "plugin-solana",
    description: "Solana blockchain integration plugin",
    actions: [],
    evaluators: [],
    providers: []
};

// Define a global runtime hook that will be called when Eliza runtime is initialized
declare global {
    interface Window {
        __eliza_runtime?: any;
        __plugin_solana_runtime_hook?: (runtime: any) => void;
    }
}

// Set up a global hook to intercept runtime initialization
if (typeof global !== 'undefined') {
    // Track if hook is already executing to prevent recursion
    let hookInProgress = false;
    
    // The hook function that will be called when runtime is initialized
    (global as any).__plugin_solana_runtime_hook = async (runtime: any) => {
        // Skip if runtime is missing or hook is already running
        if (!runtime) {
            console.warn("⚠️ Runtime hook called with null/undefined runtime");
            return;
        }
        
        // Prevent recursive calls
        if (hookInProgress) {
            console.warn("⚠️ Runtime hook recursion detected, skipping");
            return;
        }
        
        try {
            // Mark hook as in progress
            hookInProgress = true;
            
            // Use both console.log and elizaLogger to ensure visibility
            console.log("🎯 Runtime hook called with initialized runtime");
            elizaLogger.info("🎯 Runtime hook called with initialized runtime");
            
            // Apply both fix systems to ensure full compatibility
            // Basic runtime fixes first
            applyRuntimeFixes(runtime);
            console.log("✅ Basic runtime fixes applied");
            elizaLogger.info("✅ Basic runtime fixes applied");
            
            // Then apply our enhanced fixes (including memory patch)
            try {
                const enhancedFixResult = await safelyApplyFixes(runtime);
                console.log(`✅ Enhanced fixes result: ${enhancedFixResult ? "success" : "failed"}`);
                elizaLogger.info(`✅ Enhanced fixes result: ${enhancedFixResult ? "success" : "failed"}`);
                
                if (enhancedFixResult) {
                    console.log("✅ All fixes applied successfully");
                    elizaLogger.info("✅ All fixes applied successfully");
                    fixesApplied = true;
                } else {
                    console.warn("⚠️ Some fixes may not have been applied completely");
                    elizaLogger.warn("⚠️ Some fixes may not have been applied completely");
                }
            } catch (enhancedError) {
                // Log error but don't rethrow to prevent breaking the application
                console.error("❌ Error applying enhanced fixes:", enhancedError);
                elizaLogger.error("❌ Error applying enhanced fixes:", 
                    enhancedError instanceof Error ? enhancedError.message : String(enhancedError));
            }
        } catch (error) {
            // Use console.error to ensure visibility even if logger is broken
            console.error("❌ Error in runtime hook:", error);
            elizaLogger.error("❌ Error in runtime hook:", 
                error instanceof Error ? error.message : String(error));
        } finally {
            // Always reset hook status
            hookInProgress = false;
        }
    };
    
    console.log("🔌 Registered global runtime hook for Solana plugin with recursion protection");
    elizaLogger.info("🔌 Registered global runtime hook for Solana plugin with recursion protection");
}

// Add a runtime descriptor property getter to detect when runtime is added to global
let originalRuntime: any = null;

try {
    if (typeof global !== 'undefined' && global.Object && global.Object.defineProperty) {
        // Save the original runtime if it exists
        originalRuntime = (global as any).runtime;
        
        // Track if setter is already executing to prevent recursion
        let setterInProgress = false;
        
        // Define a property getter/setter for 'runtime' on the global object
        Object.defineProperty(global, 'runtime', {
            configurable: true,
            enumerable: true,
            get: function() {
                return originalRuntime;
            },
            set: function(newRuntime) {
                console.log("🔔 Runtime property was set on global object");
                elizaLogger.info("🔔 Runtime property was set on global object");
                
                // Store the runtime first to ensure it's available
                originalRuntime = newRuntime;
                
                // Skip applying fixes if already in progress (prevent recursion)
                if (setterInProgress) {
                    console.warn("⚠️ Runtime setter recursion detected, skipping fixes");
                    return true;
                }
                
                // Apply fixes when runtime is set
                if (newRuntime && !fixesApplied) {
                    try {
                        // Mark setter as in progress
                        setterInProgress = true;
                        
                        console.log("🔧 Applying fixes via property setter");
                        elizaLogger.info("🔧 Applying fixes via property setter");
                        
                        // Apply both fix systems
                        applyRuntimeFixes(newRuntime);
                        console.log("✅ Successfully applied basic runtime fixes via property setter");
                        elizaLogger.info("✅ Successfully applied basic runtime fixes via property setter");
                        
                        // Apply enhanced fixes
                        // Use an immediate async function to handle the Promise safely
                        (async () => {
                            try {
                                const enhancedResult = await safelyApplyFixes(newRuntime);
                                console.log(`✅ Enhanced fixes applied via property setter: ${enhancedResult ? "success" : "failed"}`);
                                elizaLogger.info(`✅ Enhanced fixes applied via property setter: ${enhancedResult ? "success" : "failed"}`);
                                fixesApplied = enhancedResult;
                            } catch (err) {
                                console.error("❌ Error applying enhanced fixes:", err);
                                elizaLogger.error("❌ Error applying enhanced fixes:", 
                                    err instanceof Error ? err.message : String(err));
                            } finally {
                                // Always reset the flag when done
                                setterInProgress = false;
                            }
                        })();
                    } catch (error) {
                        console.error("❌ Error in runtime property setter:", error);
                        elizaLogger.error("❌ Error in runtime property setter:", 
                            error instanceof Error ? error.message : String(error));
                        
                        // Reset flag on error
                        setterInProgress = false;
                    }
                }
                
                return true;
            }
        });
        
        console.log("🔍 Installed global.runtime property descriptor with recursion protection");
        elizaLogger.info("🔍 Installed global.runtime property descriptor with recursion protection");
    }
} catch (descriptorError) {
    console.error("❌ Error setting up runtime property descriptor:", descriptorError);
    elizaLogger.error("❌ Error setting up runtime property descriptor:", descriptorError);
}

// Apply runtime fixes with a delay to ensure the global runtime is initialized
let fixRetryCount = 0;
const MAX_RETRY_COUNT = 10; // Increase max retries
const BASE_RETRY_DELAY = 1000; // 1 second base delay

// Function to safely find a runtime and apply fixes
function findAndApplyFixes() {
    try {
        // Try different ways to access the runtime
        const runtimeCandidates = [
            global.runtime,
            global.__eliza_runtime,
            (global as any).runtime,
            (global as any).__eliza_runtime,
            (global as any).solanaRuntime, // Try additional potential runtime names
            (global as any).agentRuntime
        ];
        
        // Log available global keys for debugging
        const globalKeys = Object.keys(global).filter(key => 
            key.includes('runtime') || key.includes('agent') || key.includes('manager')
        );
        elizaLogger.debug("Available global keys that might contain runtime:", globalKeys);
        
        // Get non-null runtimes
        const validRuntimes = runtimeCandidates.filter(r => r !== null && r !== undefined);
        
        if (validRuntimes.length === 0) {
            // No runtimes found, schedule retry with exponential backoff
            fixRetryCount++;
            const delayMs = BASE_RETRY_DELAY * Math.pow(2, fixRetryCount - 1); // Exponential backoff
            
            if (fixRetryCount <= MAX_RETRY_COUNT) {
                elizaLogger.warn(`⚠️ No runtime objects found`);
                elizaLogger.warn(`⏳ Runtime not yet available (attempt ${fixRetryCount}/${MAX_RETRY_COUNT}), will retry in ${delayMs}ms`);
                
                setTimeout(findAndApplyFixes, delayMs);
            } else {
                elizaLogger.error(`❌ Failed to find runtime after ${MAX_RETRY_COUNT} attempts`);
            }
            return false;
        }
        
        // Find a runtime with messageManager
        const runtime = validRuntimes.find(r => r && r.messageManager);
        
        if (runtime) {
            elizaLogger.info("🔍 Found valid runtime object with messageManager, applying fixes", {
                runtimeType: typeof runtime,
                hasMessageManager: !!runtime.messageManager,
                messageManagerMethods: Object.keys(runtime.messageManager || {}).length
            });
            
            try {
                // Apply both fix systems for maximum compatibility
                const basicResult = applyRuntimeFixes(runtime);
                if (basicResult) {
                    elizaLogger.info("✅ Successfully applied basic runtime fixes");
                }
                
                // Apply enhanced fixes asynchronously
                safelyApplyFixes(runtime)
                    .then(enhancedResult => {
                        if (enhancedResult) {
                            elizaLogger.info("✅ Successfully applied enhanced runtime fixes");
                            fixesApplied = true;
                        } else {
                            elizaLogger.warn("⚠️ Enhanced fixes returned false");
                        }
                    })
                    .catch(err => {
                        elizaLogger.error("❌ Error applying enhanced fixes:", err);
                    });
                
                return true;
            } catch (error) {
                elizaLogger.error("❌ Error applying runtime fixes:", error);
            }
        } else if (validRuntimes.length > 0) {
            // We found runtimes but none with messageManager
            elizaLogger.warn(`⚠️ Found ${validRuntimes.length} runtime objects, but none have messageManager property`);
            elizaLogger.debug("Runtime properties:", validRuntimes.map(r => Object.keys(r || {})));
            
            // Still retry since messageManager might be added later
            fixRetryCount++;
            const delayMs = BASE_RETRY_DELAY * Math.pow(2, fixRetryCount - 1);
            
            if (fixRetryCount <= MAX_RETRY_COUNT) {
                elizaLogger.warn(`⏳ No runtime with messageManager yet (attempt ${fixRetryCount}/${MAX_RETRY_COUNT}), will retry in ${delayMs}ms`);
                setTimeout(findAndApplyFixes, delayMs);
            } else {
                elizaLogger.error(`❌ Failed to find runtime with messageManager after ${MAX_RETRY_COUNT} attempts`);
            }
            return false;
        }
        
        // If we reached here, we either:
        // 1. Found a runtime but applyRuntimeFixes failed
        // 2. Found a runtime but it doesn't have messageManager
        // Let's retry a few more times
        if (!fixesApplied && fixRetryCount < MAX_RETRY_COUNT) {
            fixRetryCount++;
            const delayMs = BASE_RETRY_DELAY * Math.pow(2, fixRetryCount - 1);
            elizaLogger.warn(`⏳ Runtime fixes not applied successfully (attempt ${fixRetryCount}/${MAX_RETRY_COUNT}), will retry in ${delayMs}ms`);
            setTimeout(findAndApplyFixes, delayMs);
        } else if (!fixesApplied) {
            elizaLogger.error(`❌ Failed to apply runtime fixes after ${MAX_RETRY_COUNT} attempts`);
        }
        
        return fixesApplied;
    } catch (error) {
        console.error("❌ Error in findAndApplyFixes:", error);
        elizaLogger.error("❌ Error in findAndApplyFixes:", error);
        
        // Retry on error
        if (fixRetryCount < MAX_RETRY_COUNT) {
            fixRetryCount++;
            const delayMs = BASE_RETRY_DELAY * Math.pow(2, fixRetryCount - 1);
            elizaLogger.warn(`⏳ Error occurred, will retry in ${delayMs}ms (attempt ${fixRetryCount}/${MAX_RETRY_COUNT})`);
            setTimeout(findAndApplyFixes, delayMs);
        } else {
            elizaLogger.error(`❌ Failed to apply runtime fixes after ${MAX_RETRY_COUNT} attempts due to errors`);
        }
        return false;
    }
}

// Replace the standalone initialization with integrated approach
try {
  // First: Validate embedding configuration
  validateEmbeddingConfiguration();
  
  // Second: Apply fixes including runtime patches with recursion protection
  findAndApplyFixes();
  
  // Third: Apply memory manager patches when runtime is available
  if (global.runtime && global.runtime.messageManager) {
    patchMemoryManagerForConsistentEmbeddings(global.runtime.messageManager);
  } else {
    // Set up a listener to patch when runtime becomes available
    const originalSetRuntime = global.setRuntime;
    global.setRuntime = function(runtime) {
      const result = originalSetRuntime.apply(this, arguments);
      // Apply patches after runtime is set
      if (runtime && runtime.messageManager) {
        patchMemoryManagerForConsistentEmbeddings(runtime.messageManager);
      }
      return result;
    };
  }
} catch (e) {
  console.error("Error during initialization:", e);
  elizaLogger.error("Error during initialization:", e);
}

export default solanaPlugin;

// Define specific exports to avoid conflict with wildcards
// Instead of re-exporting everything with wildcards which creates conflicts
export * from "./shared/utils/messageUtils.ts";

// Comment out the run exports since they don't exist in the modules
// If needed, they should be imported directly from each agent's entry file 
// or we need to modify those files to export the 'run' function
/*
export { run as runTreasuryAgent } from "./startVela.ts";
export { run as runProposalAgent } from "./startPion.ts";
export { run as runStrategyAgent } from "./startKron.ts";
export { run as runUserProfileAgent } from "./startNova.ts";
*/

export * from "./shared/utils/withTransaction.ts";