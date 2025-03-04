import { elizaLogger } from "@elizaos/core";

// Global flag to track if we're currently processing a database query
// This prevents infinite recursion if logging itself triggers database operations
let isProcessingQuery = false;

// Track if we've already patched this adapter to avoid double-patching
const patchedAdapters = new WeakSet();

/**
 * Enable SQL query logging for debugging database operations
 * Supports multiple adapter types and provides detailed query information
 * with protection against recursive calls
 * @param adapter The database adapter to enable SQL query logging for
 * @returns boolean indicating whether logging was successfully enabled
 */
export function enableSqlQueryLogging(adapter: any): boolean {
    if (!adapter) {
        console.warn('⚠️ Database adapter is null/undefined - SQL query logging skipped');
        return false; // Exit quietly rather than throwing
    }

    // Prevent double-patching the same adapter
    if (patchedAdapters.has(adapter)) {
        console.log('⏭️ SQL query logging already enabled for this adapter');
        return true;
    }

    // Log to console only (never use elizaLogger here to avoid potential recursion)
    console.log('🔧 Setting up SQL query logging with recursion protection');

    try {
        // CRITICAL: First check if this is the PostgreSQL adapter by searching for common properties
        const isPostgresAdapter = !!(
            adapter.pool || 
            adapter.options?.database?.includes('postgres') || 
            adapter.options?.connectionString?.includes('postgres')
        );

        if (isPostgresAdapter) {
            console.log('🐘 Detected PostgreSQL adapter - applying Postgres-specific protections');
        }

        // We need to protect both direct query and pooled query operations
        const patchQueryFunction = (obj: any, propName: string) => {
            if (!obj || typeof obj[propName] !== 'function') return false;
            
            // Store original function
            const originalFn = obj[propName].bind(obj);
            
            // Replace with protected version
            obj[propName] = async function(this: any, ...args: any[]) {
                // CRITICAL RECURSION PROTECTION:
                // If we're already processing a query, skip all logging and just execute
                if (isProcessingQuery) {
                    return originalFn.apply(this, args);
                }
                
                // Generate a unique ID for tracing this query
                const queryId = Math.random().toString(36).substring(2, 10);
                
                try {
                    // Set recursion guard flag BEFORE any operation
                    isProcessingQuery = true;
                    
                    // Extract query text safely
                    const [query, params] = args;
                    const queryText = typeof query === 'string' 
                        ? query 
                        : query?.text || query?.toString() || 'unknown query';
                    
                    const startTime = Date.now();
                    
                    // Only log wallet registration related queries with full details
                    // or queries that might be causing errors
                    const isWalletQuery = queryText.includes('wallet_registration');
                    const isErrorProneQuery = 
                        queryText.includes('levenshtein') || 
                        queryText.includes('vector') ||
                        queryText.includes('embedding');
                    
                    if (isWalletQuery || isErrorProneQuery) {
                        // ONLY use console.log for database debugging to avoid recursion
                        console.log(`🔍 SQL Query [${queryId}]:`, {
                            query: queryText.substring(0, 300) + (queryText.length > 300 ? '...' : ''),
                            params: params ? JSON.stringify(params).substring(0, 100) : 'none',
                            type: isWalletQuery ? 'wallet' : 'vector',
                            timestamp: new Date().toISOString()
                        });
                    }

                    // Execute query
                    const result = await originalFn.apply(this, args);

                    // Log results for special queries
                    if (isWalletQuery || isErrorProneQuery) {
                        const duration = Date.now() - startTime;
                        console.log(`📊 SQL Result [${queryId}]:`, {
                            rowCount: result?.rowCount || (Array.isArray(result) ? result.length : 0),
                            duration: `${duration}ms`
                        });
                    }

                    return result;
                } catch (error) {
                    // Log error with query context, but avoid recursion by using console.error
                    console.error(`❌ SQL Error [${queryId}]:`, {
                        query: typeof args[0] === 'string' ? args[0].substring(0, 200) : 'complex query',
                        error: error.message,
                        stack: error.stack ? error.stack.split('\n')[0] : 'no stack'
                    });
                    throw error;
                } finally {
                    // CRITICAL: Always reset the recursion guard flag, even if there's an error
                    isProcessingQuery = false;
                }
            };
            
            return true;
        };

        // Patch both the adapter and its pool if they exist
        let patchCount = 0;
        if (patchQueryFunction(adapter, 'query')) patchCount++;
        if (adapter.pool && patchQueryFunction(adapter.pool, 'query')) patchCount++;
        
        // For Postgres adapter, also patch other query-like methods that might cause recursion
        if (isPostgresAdapter) {
            const pgMethods = ['begin', 'connect', 'end'];
            for (const method of pgMethods) {
                if (adapter[method] && patchQueryFunction(adapter, method)) patchCount++;
                if (adapter.pool?.[method] && patchQueryFunction(adapter.pool, method)) patchCount++;
            }
        }

        if (patchCount === 0) {
            console.warn('⚠️ No query methods found to patch - SQL logging may not work properly');
            return false;
        }

        // Mark this adapter as patched to avoid double-patching
        patchedAdapters.add(adapter);

        // Successfully patched
        console.log(`✅ SQL query logging enabled with recursion protection (patched ${patchCount} methods)`);
        
        // This call is now outside the main processing flow and uses setTimeout for safety
        setTimeout(() => {
            if (!isProcessingQuery) { // Extra check to ensure we're not in a query already
                try {
                    // Use console.log as the safest option
                    console.log('✅ SQL query logging ready for debugging database operations');
                } catch (err) {
                    // Even this shouldn't fail, but just in case
                    console.error('Error in deferred logging', err);
                }
            }
        }, 500);
        
        return true;
    } catch (err) {
        // If patching fails, log the error but don't break the application
        console.error('❌ Failed to enable SQL query logging:', err);
        return false;
    }
} 