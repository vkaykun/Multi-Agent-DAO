#!/usr/bin/env node

/**
 * Runner script that fixes circuit breaker issues and launches the application
 */

console.log("🚀 Starting DAO system with circuit breaker fixes...");

// Set environment variables
process.env.DISABLE_EMBEDDINGS = "true";
process.env.USE_EMBEDDINGS = "false";
process.env.USE_OPENAI_EMBEDDING = "false";

console.log("✅ Embeddings disabled through environment variables");

// Dynamically implement the circuit breaker fixes
console.log("🛡️ Implementing circuit breaker fixes...");

// Define the safe vector function
function safeVector() {
  return Array(384).fill(0);
}

/**
 * Reset any open circuit breakers
 */
function resetCircuitBreakers() {
  try {
    // Access global scope
    const global = globalThis || global || {};
    let resetCount = 0;
    
    // Look for circuit breakers
    for (const key in global) {
      if (global[key] && typeof global[key] === 'object') {
        // If it looks like a circuit breaker
        if (typeof global[key].getState === 'function') {
          const state = global[key].getState();
          if (state === "OPEN" || state === "HALF_OPEN") {
            // Reset state
            global[key].state = "CLOSED";
            global[key].failureCount = 0;
            global[key].lastFailureTime = undefined;
            resetCount++;
          }
        }
      }
    }
    
    if (resetCount > 0) {
      console.log(`✅ Reset ${resetCount} circuit breakers`);
    }
    
    return true;
  } catch (error) {
    console.error("❌ Error resetting circuit breakers:", error);
    return false;
  }
}

// Patch the require system to modify modules as they're loaded
const originalRequire = module.constructor.prototype.require;
module.constructor.prototype.require = function(path) {
  // Get the original module
  const result = originalRequire.apply(this, arguments);
  
  // If this is the CircuitBreaker module, patch it
  if (path.includes('CircuitBreaker') && result?.CircuitBreaker) {
    console.log("✅ Found CircuitBreaker module, applying patch");
    
    // Save original execute method
    const originalExecute = result.CircuitBreaker.prototype.execute;
    
    // Override the execute method
    result.CircuitBreaker.prototype.execute = async function(operation) {
      // If circuit breaker is already open, reset it
      if (this.getState() === "OPEN") {
        console.log("🔄 Resetting OPEN circuit breaker");
        this.state = "CLOSED";
        this.failureCount = 0;
        this.lastFailureTime = undefined;
      }
      
      try {
        return await originalExecute.call(this, async () => {
          try {
            return await operation();
          } catch (error) {
            // Check if this is a vector dimension error
            if (error.message && (
                error.message.includes("vector dimensions") || 
                error.message.includes("embedding dimension")
            )) {
              console.log("🛡️ Intercepted vector dimension error, bypassing circuit breaker");
              console.error("Vector dimension error (bypassed):", error.message);
              
              // Return empty results rather than failing
              return [];
            }
            // For other errors, let them propagate
            throw error;
          }
        });
      } catch (error) {
        if (error.message && (
            error.message.includes("vector dimensions") || 
            error.message.includes("embedding dimension")
        )) {
          console.log("🛡️ Caught vector dimension error at circuit breaker level");
          return []; // Return empty results rather than failing
        }
        throw error;
      }
    };
  }
  
  // Also patch the PostgreSQL adapter
  if (path.includes('adapter-postgres') || path.includes('postgres/index')) {
    console.log("✅ Found PostgreSQL adapter, applying patches");
    
    // Patch searchMemories if it exists
    if (result.searchMemories) {
      const originalSearch = result.searchMemories;
      result.searchMemories = async function(opts) {
        if (process.env.DISABLE_EMBEDDINGS === 'true') {
          console.log("⏩ Bypassing searchMemories vector operation");
          return this.getMemories({
            roomId: opts.roomId,
            count: opts.match_count || 10,
            unique: opts.unique,
            tableName: opts.tableName,
            agentId: opts.agentId
          });
        }
        
        try {
          return await originalSearch.apply(this, arguments);
        } catch (error) {
          if (error.message && (
              error.message.includes("vector dimensions") || 
              error.message.includes("embedding dimension")
          )) {
            console.log("🛡️ Caught vector dimension error in searchMemories, using fallback");
            return this.getMemories({
              roomId: opts.roomId,
              count: opts.match_count || 10,
              unique: opts.unique,
              tableName: opts.tableName,
              agentId: opts.agentId
            });
          }
          throw error;
        }
      };
    }
    
    // Patch createMemory if it exists
    if (result.createMemory) {
      const originalCreate = result.createMemory;
      result.createMemory = async function(memory, tableName, unique) {
        if (process.env.DISABLE_EMBEDDINGS === 'true' && memory.embedding) {
          console.log("⏩ Removing embedding from memory object");
          delete memory.embedding; // Remove embedding to avoid dimension errors
        }
        
        try {
          return await originalCreate.apply(this, arguments);
        } catch (error) {
          if (error.message && (
              error.message.includes("vector dimensions") || 
              error.message.includes("embedding dimension")
          )) {
            console.log("🛡️ Caught vector dimension error in createMemory, trying without embedding");
            // Try again without the embedding
            const memoryCopy = {...memory};
            delete memoryCopy.embedding;
            return originalCreate.call(this, memoryCopy, tableName, unique);
          }
          throw error;
        }
      };
    }
  }
  
  return result;
};

// Print success message
console.log("✅ Circuit breaker and vector fixes applied");
console.log("✅ Ready to launch application...");
console.log("");

// Now run the actual application
// We need to determine the main file to run

// Get the command line arguments
const args = process.argv.slice(2);

// If no arguments were provided, use default
if (args.length === 0) {
  console.log("Starting with default entry point: src/index.js");
  
  try {
    // Try to require the main module
    require('./src/index.js');
  } catch (error) {
    // If that fails, try TypeScript entry point
    if (error.code === 'MODULE_NOT_FOUND') {
      try {
        console.log("Default JS entry point not found, trying TypeScript entry point");
        require('ts-node/register');
        require('./src/index.ts');
      } catch (tsError) {
        console.error("Error starting application:", tsError);
        console.log("\nPlease specify the entry point when running this script:");
        console.log("  node run-fixed.js path/to/your/entry/point.js");
        process.exit(1);
      }
    } else {
      console.error("Error starting application:", error);
      process.exit(1);
    }
  }
} else {
  // Use the provided entry point
  const entryPoint = args[0];
  console.log(`Starting with entry point: ${entryPoint}`);
  
  try {
    // Check if it's a TypeScript file
    if (entryPoint.endsWith('.ts')) {
      require('ts-node/register');
    }
    
    require(entryPoint);
  } catch (error) {
    console.error("Error starting application:", error);
    process.exit(1);
  }
} 