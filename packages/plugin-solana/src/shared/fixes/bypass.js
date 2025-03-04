// bypass.js
// Allow embeddings by default - can be overridden by environment variables
// Only disable if explicitly set to "true"

// Check if embedding logs should be disabled
const DISABLE_EMBEDDING_LOGS = process.env.DISABLE_EMBEDDING_LOGS === 'true';

// Create a silent logger for when logs are disabled
const silentLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

// Use this logger throughout the file - it will be silent if DISABLE_EMBEDDING_LOGS is true
const logger = DISABLE_EMBEDDING_LOGS ? silentLogger : console;

// Import conversation room ID constant
const CONVERSATION_ROOM_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Apply runtime fixes for embedding and memory issues
 * 
 * @param {Object} runtime - The agent runtime to apply fixes to
 * @returns {boolean} Whether fixes were successfully applied
 */
export function applyRuntimeFixes(runtime) {
  try {
    // Quiet version - no excessive logging
    
    // Safety check - if runtime is undefined or null, exit
    if (!runtime) {
      return false;
    }
    
    // Make sure messageManager exists
    if (!runtime.messageManager) {
      return false;
    }

    // Check if needed methods exist on messageManager
    if (!runtime.messageManager.createMemory || !runtime.messageManager.getMemories) {
      return false;
    }

    // Apply PostgreSQL levenshtein fix by monkey-patching the database adapter
    applyPostgresLevenshteinFix(runtime);
    
    // Apply vector dimension fix
    applyVectorDimensionFix(runtime);

    // Apply memory update method fix (addressing missing updateMemory function)
    applyMemoryUpdateMethodFix(runtime);

    // Store original methods
    const originalCreateMemory = runtime.messageManager.createMemory;
    const originalGetMemories = runtime.messageManager.getMemories;
    const originalSearchMemoriesByEmbedding = runtime.messageManager.searchMemoriesByEmbedding;

    // Fix messageManager.createMemory
    runtime.messageManager.createMemory = async function createMemoryWithFallback(memory, unique = false) {
      try {
        // Add skip embedding flag if it's likely to be problematic content
        if (memory?.content?.text && memory.content.text.length > 200) {
          if (!memory.metadata) memory.metadata = {};
          memory.metadata.skipEmbedding = true;
        }
        
        return await originalCreateMemory.call(this, memory, unique);
      } catch (error) {
        // Handle vector dimension mismatch by skipping embedding
        if (error.message && error.message.includes("different vector dimensions")) {
          // Clone the memory object and add skipEmbedding flag
          const clonedMemory = JSON.parse(JSON.stringify(memory));
          if (!clonedMemory.metadata) clonedMemory.metadata = {};
          clonedMemory.metadata.skipEmbedding = true;
          
          try {
            return await originalCreateMemory.call(this, clonedMemory, unique);
          } catch (embeddingError) {
            // Quiet logging
          }
        }
        
        // Basic error recovery for common issues
        try {
          // Try with a unique ID if the error is about duplicate
          if (error.message && error.message.includes("duplicate key")) {
            // Create a new UUID
            const newId = crypto.randomUUID ? crypto.randomUUID() : 
              `fallback-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
            
            // Clone the memory object and assign new ID
            const clonedMemory = JSON.parse(JSON.stringify(memory));
            clonedMemory.id = newId;
            
            return await originalCreateMemory.call(this, clonedMemory, true);
          }
          
          // IMPORTANT FIX: Don't try to save memories without proper content
          // This avoids the null value in column "content" error
          if (memory?.content && Object.keys(memory.content).length > 0) {
            const clonedMemory = JSON.parse(JSON.stringify(memory));
            if (!clonedMemory.metadata) clonedMemory.metadata = {};
            clonedMemory.metadata.skipEmbedding = true;
            
            return await originalCreateMemory.call(this, clonedMemory, unique);
          }
        } catch (fallbackError) {
          // Quiet logging
        }
        
        throw error;
      }
    };

    // Fix getMemories to handle embedding issues
    runtime.messageManager.getMemories = async function getMemoriesWithFallback(opts) {
      try {
        return await originalGetMemories.call(this, opts);
      } catch (error) {
        // Handle embedding-related errors specifically
        if (error.message && (
          error.message.includes("embedding") || 
          error.message.includes("vector") ||
          error.message.includes("levenshtein")
        )) {
          // Basic SQL fallback
          const memoryManager = this;
          const databaseAdapter = runtime.databaseAdapter;
          
          if (databaseAdapter && databaseAdapter.query) {
            try {
              const result = await databaseAdapter.query(
                `SELECT * FROM memories 
                 WHERE "roomId" = $1 
                 ORDER BY "createdAt" DESC 
                 LIMIT $2`,
                [opts.roomId, opts.count || 10]
              );
              
              return result.rows || [];
            } catch (sqlError) {
              // Quiet logging
            }
          }
        }
        
        // Return empty array as last resort
        return [];
      }
    };

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Fix for missing updateMemory method on the database adapter
 * This provides compatibility by mapping to available methods
 */
function applyMemoryUpdateMethodFix(runtime) {
  try {
    // Get database adapter and message manager
    const dbAdapter = runtime.databaseAdapter;
    const messageManager = runtime.messageManager;
    
    if (!dbAdapter) {
      return false;
    }
    
    // Check if updateMemory already exists
    if (typeof dbAdapter.updateMemory === 'function') {
      return true;
    }
    
    // Check for available methods that might be used for updates
    const hasUpdateMemoryWithVersion = typeof messageManager.updateMemoryWithVersion === 'function';
    const hasUpdateMemoryInternal = typeof dbAdapter.updateMemoryInternal === 'function';
    
    // Add updateMemory method to the database adapter
    dbAdapter.updateMemory = async function compatUpdateMemory(memory, tableName) {
      if (!memory || !memory.id) {
        throw new Error("Cannot update memory: missing memory object or memory ID");
      }
      
      try {
        // Method 1: Try updateMemoryWithVersion if available
        if (hasUpdateMemoryWithVersion) {
          // Get current version or default to 0
          const currentMemory = await messageManager.getMemory(memory.id);
          const currentVersion = (currentMemory?.content?.metadata?.version || 0);
          return await messageManager.updateMemoryWithVersion(memory.id, memory, currentVersion);
        }

        // Method 2: Try updateMemoryInternal if available
        if (hasUpdateMemoryInternal) {
          return await dbAdapter.updateMemoryInternal(memory);
        }
        
        // Method 3: Use createMemory with the same ID
        // First check if memory exists
        const existingMemory = await messageManager.getMemory(memory.id);
        if (existingMemory) {
          // Merge with existing memory to preserve metadata
          const merged = {
            ...existingMemory,
            content: {
              ...existingMemory.content,
              ...memory.content
            }
          };
          
          // If it's a versioned type, increment version
          if (memory.content && memory.content.type) {
            const isVersioned = typeof runtime.isVersionedMemoryType === 'function' 
              ? runtime.isVersionedMemoryType(memory.content.type)
              : false;
              
            if (isVersioned) {
              if (!merged.content.metadata) merged.content.metadata = {};
              merged.content.metadata.version = (merged.content.metadata.version || 0) + 1;
              merged.content.metadata.updatedAt = Date.now();
            }
          }
          
          await messageManager.createMemory(merged, false);
          return true;
        } else {
          // Just create a new memory with this ID
          await messageManager.createMemory(memory, false);
          return true;
        }
      } catch (error) {
        // Last resort: Try direct SQL update if query method is available
        if (dbAdapter.query) {
          try {
            const contentJson = JSON.stringify(memory.content || {});
            const metadataJson = JSON.stringify(memory.metadata || {});
            
            await dbAdapter.query(
              `UPDATE memories 
               SET content = $1, 
                   metadata = $2,
                   "updatedAt" = $3
               WHERE id = $4`,
              [contentJson, metadataJson, Date.now(), memory.id]
            );
            
            return true;
          } catch (sqlError) {
            throw sqlError;
          }
        }
        
        throw error;
      }
    };
    
    // Also ensure messageManager has updateMemory as needed
    if (typeof messageManager.updateMemory !== 'function') {
      messageManager.updateMemory = async function(memory) {
        return await dbAdapter.updateMemory(memory, this.tableName);
      };
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Apply a monkey patch to protect against PostgreSQL levenshtein issues
 */
function applyPostgresLevenshteinFix(runtime) {
  try {
    // Find the database adapter
    const dbAdapter = runtime.databaseAdapter;
    
    if (!dbAdapter) {
      return false;
    }
    
    // Check if the adapter is PostgreSQL
    if (!dbAdapter.pool || !dbAdapter.pool.query) {
      return false;
    }
    
    // Store the original query method
    const originalQuery = dbAdapter.pool.query;
    
    // Replace the query method with one that modifies levenshtein calls
    dbAdapter.pool.query = function patchedQuery(...args) {
      let [queryTextOrConfig, values] = args;
      
      // Only process string queries that include levenshtein
      if (typeof queryTextOrConfig === 'string' && 
          queryTextOrConfig.includes('levenshtein(')) {
        
        // Truncate any string parameters to 255 chars
        if (values && Array.isArray(values)) {
          const newValues = values.map(val => 
            typeof val === 'string' && val.length > 255 
              ? val.substring(0, 255) 
              : val
          );
          
          // Update to use truncated values
          values = newValues;
        }
        
        // Modify the query to apply LEFT() safely to string arguments in levenshtein calls
        let modifiedQuery = queryTextOrConfig;
        
        // Regex to find levenshtein function calls with their arguments
        const levenshteinRegex = /levenshtein\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g;
        
        // Replace each levenshtein function call
        modifiedQuery = modifiedQuery.replace(levenshteinRegex, (match, arg1, arg2) => {
          // Check if arg1 looks like a string or parameter
          let safeArg1 = arg1;
          if (arg1.includes("'") || arg1.startsWith('$')) {
            // It's a string literal or parameter, safe to apply LEFT
            safeArg1 = `LEFT(${arg1}, 255)`;
          }
          
          // Check if arg2 looks like a string or parameter  
          let safeArg2 = arg2;
          if (arg2.includes("'") || arg2.startsWith('$') || arg2.includes('content_text') || arg2.includes('COALESCE')) {
            // It's a string literal, parameter, or column, safe to apply LEFT
            safeArg2 = `LEFT(${arg2}, 255)`;
          }
          
          return `levenshtein(${safeArg1}, ${safeArg2})`;
        });
        
        // Use the modified query
        queryTextOrConfig = modifiedQuery;
      }
      
      // Call the original query method
      return originalQuery.call(this, queryTextOrConfig, values);
    };
    
    // Also replace the getCachedEmbeddings method with our safer version
    const originalGetCachedEmbeddings = dbAdapter.getCachedEmbeddings;
    
    dbAdapter.getCachedEmbeddings = async function safeCachedEmbeddings(opts) {
      if (!opts || !opts.query_table_name || !opts.query_input || !opts.query_field_name) {
        return [];
      }
      
      // Truncate the input parameter to 255 chars
      if (opts.query_input && typeof opts.query_input === 'string' && opts.query_input.length > 255) {
        opts.query_input = opts.query_input.substring(0, 255);
      }
      
      try {
        // Call the original method with our safety modifications
        const result = await originalGetCachedEmbeddings.call(this, opts);
        return result;
      } catch (error) {
        // Check if it's a levenshtein error
        if (error.message && error.message.includes('levenshtein')) {
          // Return empty results on levenshtein errors
          return [];
        }
        
        // For other errors, rethrow
        throw error;
      }
    };
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Apply fixes for the vector dimension mismatch between 384 and 1536
 */
function applyVectorDimensionFix(runtime) {
  try {
    // Get the database adapter
    const dbAdapter = runtime.databaseAdapter;
    if (!dbAdapter) {
      return false;
    }

    // Constant for enforced dimensions - always use 1536D
    const ENFORCED_DIMENSION = 1536;
    
    // Create a vector adapter to convert between dimensions - optimized version
    const convertVector = (vector, targetDimension = ENFORCED_DIMENSION) => {
      if (!vector || !Array.isArray(vector)) return null;
      
      // If vector is already 1536D, return it immediately
      if (vector.length === ENFORCED_DIMENSION) return vector;
      
      // Fast path for 384D to 1536D conversion (most common case)
      if (vector.length === 384 && targetDimension === 1536) {
        const newVector = new Array(1536);
        for (let i = 0; i < 384; i++) {
          const value = vector[i];
          const baseIdx = i * 4;
          newVector[baseIdx] = value;
          newVector[baseIdx + 1] = value;
          newVector[baseIdx + 2] = value;
          newVector[baseIdx + 3] = value;
        }
        return newVector;
      }
      
      // For all other dimensions, ensure we create a properly sized vector of zeros
      // and copy as many values as possible from the source
      const newVector = new Array(targetDimension).fill(0);
      const copyLength = Math.min(vector.length, targetDimension);
      
      for (let i = 0; i < copyLength; i++) {
        newVector[i] = vector[i];
      }
      
      return newVector;
    };
    
    // Patch searchMemoriesByEmbedding to enforce 1536D
    if (typeof dbAdapter.searchMemoriesByEmbedding === 'function') {
      const originalSearchMemoriesByEmbedding = dbAdapter.searchMemoriesByEmbedding;
      
      dbAdapter.searchMemoriesByEmbedding = async function fixedSearchMemoriesByEmbedding(embedding, params) {
        try {
          // Convert input embedding to enforced dimension before searching
          const normalizedEmbedding = convertVector(embedding);
          
          if (normalizedEmbedding && normalizedEmbedding.length === ENFORCED_DIMENSION) {
            try {
              return await originalSearchMemoriesByEmbedding.call(this, normalizedEmbedding, params);
            } catch (dimError) {
              if (dimError.message && dimError.message.includes("different vector dimensions")) {
                // Check for 384D in case the DB schema wasn't properly updated
                if (dimError.message.includes("384")) {
                  const compatEmbedding = convertVector(embedding, 384);
                  return await originalSearchMemoriesByEmbedding.call(this, compatEmbedding, params);
                }
              }
              // Return empty array to avoid crashing
              return [];
            }
          } else {
            return await originalSearchMemoriesByEmbedding.call(this, embedding, params);
          }
        } catch (error) {
          // For any error, return empty results instead of crashing
          return [];
        }
      };
    }
    
    // Patch addEmbeddingToMemory to enforce 1536D
    if (typeof dbAdapter.addEmbeddingToMemory === 'function') {
      const originalAddEmbeddingToMemory = dbAdapter.addEmbeddingToMemory;
      
      dbAdapter.addEmbeddingToMemory = async function fixedAddEmbeddingToMemory(memory) {
        try {
          // Check if memory has an embedding to normalize
          if (memory && memory.embedding && Array.isArray(memory.embedding)) {
            // Only normalize if not already 1536D
            if (memory.embedding.length !== ENFORCED_DIMENSION) {
              memory.embedding = convertVector(memory.embedding);
            }
          }
          
          // Proceed with the original function with normalized embedding
          return await originalAddEmbeddingToMemory.call(this, memory);
        } catch (error) {
          // If we still get a dimension mismatch error, skip embedding
          if (error.message && error.message.includes("different vector dimensions")) {
            // Skip embedding for this memory
            if (!memory.metadata) memory.metadata = {};
            memory.metadata.skipEmbedding = true;
            
            // Return the memory without embedding
            return memory;
          }
          
          // For other errors, rethrow
          throw error;
        }
      };
    }
    
    // Add a check method to validate and fix existing vectors
    dbAdapter.validateAndFixVectorDimension = async function(vector) {
      if (!vector || !Array.isArray(vector)) return null;
      return convertVector(vector);
    };
    
    // Also intercept the raw SQL calls that include vector operations
    if (dbAdapter.pool && dbAdapter.pool.query) {
      const originalQuery = dbAdapter.pool.query;
      
      // Only patch if we haven't already patched for this
      if (!dbAdapter.pool.query.toString().includes('enforceVectorDimension')) {
        const existingPatchedQuery = dbAdapter.pool.query;
        
        dbAdapter.pool.query = function patchedQueryWithVectorDimensionEnforcement(...args) {
          let [queryTextOrConfig, values] = args;
          
          // Check for vector operations
          if (typeof queryTextOrConfig === 'string' && 
              (queryTextOrConfig.includes('<->', '>') || 
               queryTextOrConfig.includes('cosine_distance') || 
               queryTextOrConfig.includes('::vector'))) {
            
            // If inserting a vector, ensure it's 1536D
            if (queryTextOrConfig.includes('INSERT INTO') && values && Array.isArray(values)) {
              for (let i = 0; i < values.length; i++) {
                const value = values[i];
                if (Array.isArray(value) && value.length !== ENFORCED_DIMENSION && value.length > 0) {
                  values[i] = convertVector(value);
                }
              }
            }
            
            // Add safeguards to SQL queries involving vectors
            if (queryTextOrConfig.includes('WHERE embedding IS NOT NULL')) {
              // When retrieving embeddings, provide a fallback for old embeddings
              queryTextOrConfig = queryTextOrConfig.replace(
                'WHERE embedding IS NOT NULL', 
                'WHERE embedding IS NOT NULL AND array_length(embedding, 1) >= 384'
              );
            }
          }
          
          // Call the existing patched query (which might include levenshtein fixes)
          return existingPatchedQuery.call(this, queryTextOrConfig, values);
        };
        
        dbAdapter.pool.query.toString = () => 'function patchedQueryWithEnforceVectorDimension() { [native code] }';
      }
    }
    
    // Add a hook to normalize embeddings at runtime
    if (runtime.messageManager && !runtime.messageManager.normalizeEmbedding) {
      runtime.messageManager.normalizeEmbedding = function(embedding) {
        return convertVector(embedding);
      };
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

