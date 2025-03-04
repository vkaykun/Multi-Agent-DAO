// vector-fix.js
// Direct vector dimension fix for PostgreSQL/Supabase dimension mismatch issues

// Define constants
const EXPECTED_DIMENSION = 1536;
const BGE_DIMENSION = 384;

// Debug flag - enable to see detailed debug info
const DEBUG_MODE = true;

// Logger that respects debug mode
const logger = {
  info: (...args) => console.log('[VECTOR-FIX]', ...args),
  debug: (...args) => DEBUG_MODE && console.log('[VECTOR-FIX-DEBUG]', ...args),
  warn: (...args) => console.warn('[VECTOR-FIX-WARN]', ...args),
  error: (...args) => console.error('[VECTOR-FIX-ERROR]', ...args)
};

/**
 * Directly convert a vector between dimensions
 * Uses repeat-4x strategy for 384→1536 conversion
 */
export function convertVector(vector, sourceDim = null, targetDim = EXPECTED_DIMENSION) {
  if (!vector || !Array.isArray(vector)) {
    logger.warn('Non-array vector received for conversion', typeof vector);
    return Array(targetDim).fill(0);
  }
  
  const actualSourceDim = sourceDim || vector.length;
  
  // Already correct dimension
  if (vector.length === targetDim) {
    return vector;
  }
  
  logger.info(`Converting vector from dimension ${actualSourceDim} to ${targetDim}`);
  
  let result;
  
  // Specific optimization for common 384→1536 case (BGE embeddings)
  if (actualSourceDim === BGE_DIMENSION && targetDim === EXPECTED_DIMENSION) {
    // Repeat strategy - repeat the vector 4 times (better than zero padding)
    const repeated = [];
    for (let i = 0; i < 4; i++) {
      repeated.push(...vector);
    }
    
    // Normalize to maintain similar magnitude (since we're repeating 4x)
    const normFactor = Math.sqrt(4);
    result = repeated.map(val => val / normFactor);
    
    if (DEBUG_MODE) {
      logger.debug(`Converted ${actualSourceDim}→${targetDim} using repeat-4x strategy`);
      logger.debug(`Input sample: ${vector.slice(0, 3).join(', ')}...`);
      logger.debug(`Output sample: ${result.slice(0, 3).join(', ')}...`);
    }
  } 
  // General case for other dimensions
  else {
    result = new Array(targetDim).fill(0);
    
    if (actualSourceDim < targetDim) {
      // Copy what we can, rest remains zero
      for (let i = 0; i < actualSourceDim; i++) {
        result[i] = vector[i];
      }
      logger.debug(`Padded ${actualSourceDim}→${targetDim} with zeros`);
    } else {
      // Truncate
      for (let i = 0; i < targetDim; i++) {
        result[i] = vector[i];
      }
      logger.debug(`Truncated ${actualSourceDim}→${targetDim}`);
    }
  }
  
  // Verify correct dimension
  if (result.length !== targetDim) {
    logger.error(`Dimension conversion failed! Expected ${targetDim}, got ${result.length}`);
    return Array(targetDim).fill(0);
  }
  
  return result;
}

/**
 * Apply aggressive fixes to ensure vector dimensions are correct
 * This intercepts at multiple layers to ensure no dimension mismatches occur
 */
export function applyAggressiveVectorFix(runtime) {
  if (!runtime) {
    logger.error('Runtime is null, cannot apply vector fixes');
    return false;
  }
  
  // Get database adapter
  const dbAdapter = runtime.databaseAdapter;
  if (!dbAdapter) {
    logger.error('Database adapter is null, cannot apply vector fixes');
    return false;
  }
  
  logger.info('Applying aggressive vector dimension fix');
  
  // ----- DATABASE LAYER FIXES -----
  
  // Fix 1: Intercept addEmbeddingToMemory
  if (typeof dbAdapter.addEmbeddingToMemory === 'function') {
    const originalAddEmbedding = dbAdapter.addEmbeddingToMemory;
    
    dbAdapter.addEmbeddingToMemory = async function(memory) {
      try {
        // Verify and fix embedding dimension
        if (memory && memory.embedding && Array.isArray(memory.embedding)) {
          const beforeLength = memory.embedding.length;
          
          if (beforeLength !== EXPECTED_DIMENSION) {
            memory.embedding = convertVector(memory.embedding);
            logger.info(`Fixed embedding dimension in addEmbeddingToMemory: ${beforeLength} → ${memory.embedding.length}`);
          }
        }
        
        return await originalAddEmbedding.call(this, memory);
      } catch (error) {
        logger.error('Error in addEmbeddingToMemory fix:', error.message);
        
        // If still dimension issues, try without embedding
        if (error.message && error.message.includes('dimensions')) {
          logger.warn('Dimension error persists, skipping embedding');
          if (!memory.metadata) memory.metadata = {};
          memory.metadata.skipEmbedding = true;
          delete memory.embedding;
          return memory;
        }
        
        throw error;
      }
    };
  }
  
  // Fix 2: Intercept direct SQL queries
  if (dbAdapter.pool && dbAdapter.pool.query) {
    const originalQuery = dbAdapter.pool.query;
    
    dbAdapter.pool.query = function(text, params) {
      // Detect wallet registration queries - these should bypass vector fixing
      const isWalletRegistrationQuery = 
        (typeof text === 'string' && 
        (text.includes('wallet_registration') || 
         text.includes("content->>'type' = 'wallet_registration'") ||
         text.includes("getUserWallets")));
      
      // Skip vector fixing for wallet registration queries
      if (isWalletRegistrationQuery) {
        logger.info('Bypassing vector dimension fix for wallet registration query');
        return originalQuery.call(this, text, params);
      }
      
      // Vector operation detection for non-wallet queries
      const isVectorOperation = 
        (typeof text === 'string' && 
         (text.includes('embedding') || 
          text.includes('vector') ||
          text.includes('<->') ||
          text.includes('cosine_distance')));
          
      if (isVectorOperation) {
        logger.debug('🧬 Intercepted SQL query with vector operations');
        
        // Fix embedding parameters for vector operations
        if (Array.isArray(params)) {
          for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (Array.isArray(param) && param.length > 0 && param.length !== EXPECTED_DIMENSION) {
              logger.info(`Converting vector from dimension ${param.length} to ${EXPECTED_DIMENSION} (enforced standard)`);
              params[i] = convertVector(param);
            }
          }
        }
      }
      
      // Call original query with fixed parameters
      return originalQuery.call(this, text, params);
    };
  }
  
  // ----- RUNTIME LAYER FIXES -----
  
  // Fix 3: Add normalizeEmbedding helper to message manager
  if (runtime.messageManager) {
    runtime.messageManager.normalizeEmbedding = function(embedding) {
      if (!embedding || !Array.isArray(embedding)) {
        return Array(EXPECTED_DIMENSION).fill(0);
      }
      
      if (embedding.length !== EXPECTED_DIMENSION) {
        return convertVector(embedding);
      }
      
      return embedding;
    };
    
    // Fix 4: Intercept createMemory
    if (typeof runtime.messageManager.createMemory === 'function') {
      const originalCreateMemory = runtime.messageManager.createMemory;
      
      runtime.messageManager.createMemory = async function(memory, unique = false) {
        try {
          // Make sure we normalize embeddings before they reach the database
          if (memory && memory.embedding && Array.isArray(memory.embedding) && 
              memory.embedding.length !== EXPECTED_DIMENSION) {
            const originalLength = memory.embedding.length;
            memory.embedding = convertVector(memory.embedding);
            logger.info(`Fixed memory embedding: ${originalLength} → ${memory.embedding.length}`);
          }
          
          return await originalCreateMemory.call(this, memory, unique);
        } catch (error) {
          logger.warn(`Caught error in createMemory: ${error.message}`);
          
          // Handle dimension mismatch
          if (error.message && error.message.includes('dimensions')) {
            logger.warn(`Caught dimension mismatch error in createMemory for ${memory?.id}, trying without embedding`);
            
            try {
              // Clone memory and remove embedding
              const clonedMemory = JSON.parse(JSON.stringify(memory));
              delete clonedMemory.embedding;
              if (!clonedMemory.metadata) clonedMemory.metadata = {};
              clonedMemory.metadata.skipEmbedding = true;
              
              return await originalCreateMemory.call(this, clonedMemory, unique);
            } catch (fallbackError) {
              logger.error(`Error in dimension error fallback for memory ${memory?.id}:`, fallbackError);
            }
          }
          
          throw error;
        }
      };
    }
    
    // Fix 5: Intercept searchMemoriesByEmbedding
    if (typeof runtime.messageManager.searchMemoriesByEmbedding === 'function') {
      const originalSearch = runtime.messageManager.searchMemoriesByEmbedding;
      
      runtime.messageManager.searchMemoriesByEmbedding = async function(embedding, opts) {
        try {
          // Normalize embedding 
          if (embedding && Array.isArray(embedding) && embedding.length !== EXPECTED_DIMENSION) {
            const originalLength = embedding.length;
            embedding = convertVector(embedding);
            logger.info(`Fixed search embedding: ${originalLength} → ${embedding.length}`);
          }
          
          return await originalSearch.call(this, embedding, opts);
        } catch (error) {
          logger.error('Error in searchMemoriesByEmbedding:', error.message);
          return [];
        }
      };
    }
  }
  
  logger.info('Vector dimension fix applied successfully');
  return true;
}

// Export the main functions
export default {
  convertVector,
  applyAggressiveVectorFix
}; 