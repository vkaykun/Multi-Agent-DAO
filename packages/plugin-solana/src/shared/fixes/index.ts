import { elizaLogger } from "@elizaos/core";
import { patchMemoryManager } from "./memory-patch.ts";
import { enableSqlQueryLogging } from "./db-query-log.ts";

// Track whether fixes have been applied to avoid duplicate application
let fixesApplied = false;

// Constants for retry mechanism
const MAX_RETRY_COUNT = 3;
const BASE_RETRY_DELAY = 1000; // 1 second
let fixRetryCount = 0;

/**
 * Try to find the database adapter from various possible paths
 */
function findDatabaseAdapter(runtime: any): any | null {
    if (!runtime) return null;

    // Try different possible paths to find the adapter
    const possiblePaths = [
        runtime.messageManager?.adapter,
        runtime.messageManager?.databaseAdapter,
        runtime.databaseAdapter,
        runtime.messageManager?.getAdapter?.(),
        runtime.getAdapter?.()
    ];

    // Return the first non-null adapter found
    return possiblePaths.find(adapter => adapter != null) || null;
}

/**
 * Apply runtime fixes in a safe manner with retries
 * Enhances memory management and database operations
 * @param runtime The ElizaOS runtime instance
 * @returns Promise resolving to true if fixes were applied, false otherwise
 */
export async function safelyApplyFixes(runtime: any): Promise<boolean> {
    if (fixesApplied) {
        elizaLogger.debug("⏭️ Runtime fixes already applied, skipping");
        return true;
    }
    
    if (!runtime) {
        elizaLogger.error("❌ Cannot apply fixes - runtime is null or undefined");
        return false;
    }
    
    elizaLogger.info("🔧 Applying enhanced runtime fixes for wallet registration and memory management");
    
    let success = true;
    
    try {
        // Patch memory manager
        if (runtime.messageManager) {
            elizaLogger.info("🔍 Applying memory manager patches for correct wallet retrieval");
            patchMemoryManager(runtime);
            elizaLogger.info("✅ Memory manager patched successfully for Treasury operations");
            
            // Add debug logging to show memory filter application
            const originalGetMemories = runtime.messageManager.getMemories;
            if (originalGetMemories) {
                runtime.messageManager.getMemories = async function(options: any) {
                    // Only log wallet registration filters to avoid excessive logging
                    const isWalletQuery = options && 
                        (options._treasuryOperation || 
                         (options.filter && 
                          ((typeof options.filter === 'object' && options.filter.content && options.filter.content.type === 'wallet_registration') ||
                           (typeof options.filter === 'string' && options.filter.includes('wallet_registration')))));
                        
                    if (isWalletQuery) {
                        console.log("🔍 WALLET REGISTRATION QUERY", {
                            options: JSON.stringify(options, null, 2),
                            filter: options.filter ? JSON.stringify(options.filter, null, 2) : "none",
                            roomId: options.roomId,
                            treasuryOp: options._treasuryOperation
                        });
                    }
                    
                    // Call original method
                    const results = await originalGetMemories.call(this, options);
                    
                    // Log results for wallet registration queries, but avoid logging large result sets
                    if (isWalletQuery) {
                        console.log(`📊 WALLET QUERY RESULTS: Found ${results ? results.length : 0} memories`, {
                            count: results ? results.length : 0,
                            memory_ids: results ? results.slice(0, 5).map((m: any) => m.id).join(', ') : 'none',
                            hasMore: results && results.length > 5 ? `...and ${results.length - 5} more` : false
                        });
                    }
                    
                    return results;
                };
                elizaLogger.info("✅ Enhanced getMemories with wallet registration debug logging");
            }
        } else {
            elizaLogger.warn("⚠️ Cannot patch memory manager - messageManager not found");
            success = false;
        }
        
        // Enable SQL query logging with enhanced adapter detection
        const dbAdapter = findDatabaseAdapter(runtime);
        if (dbAdapter) {
            elizaLogger.info("🔍 Found database adapter, enabling SQL query logging with recursion protection");
            try {
                enableSqlQueryLogging(dbAdapter);
                elizaLogger.info("✅ SQL query logging enabled successfully with safety measures");
            } catch (err) {
                console.warn("⚠️ Failed to enable SQL query logging", err);
                elizaLogger.warn("⚠️ Failed to enable SQL query logging, but continuing - this is non-critical", 
                    { error: err instanceof Error ? err.message : String(err) });
                // Don't set success to false here - SQL logging is optional
                elizaLogger.info("ℹ️ Continuing without SQL query logging");
            }
        } else {
            elizaLogger.warn("⚠️ Cannot enable SQL query logging - adapter not found in any expected location");
            elizaLogger.info("ℹ️ Continuing without SQL query logging");
            // Don't set success to false - SQL logging is optional
        }
        
        if (success) {
            fixesApplied = true;
            elizaLogger.info("✅ All enhanced runtime fixes applied successfully");
        }
        
        return success;
    } catch (error) {
        elizaLogger.error("❌ Error applying enhanced runtime fixes:", error);
        console.error("❌ Error applying enhanced runtime fixes:", error);
        
        // Retry logic for transient errors
        fixRetryCount++;
        if (fixRetryCount <= MAX_RETRY_COUNT) {
            const retryDelay = BASE_RETRY_DELAY * Math.pow(2, fixRetryCount - 1);
            elizaLogger.warn(`⏳ Will retry applying fixes in ${retryDelay}ms (attempt ${fixRetryCount}/${MAX_RETRY_COUNT})`);
            
            return new Promise((resolve) => {
                setTimeout(async () => {
                    const retryResult = await safelyApplyFixes(runtime);
                    resolve(retryResult);
                }, retryDelay);
            });
        }
        
        return false;
    }
} 