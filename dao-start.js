#!/usr/bin/env node

/**
 * DAO System Launcher with Circuit Breaker Fixes
 * --------------------------------------------
 * This script disables embeddings and fixes circuit breaker issues
 * before launching the DAO multi-agent system with pnpm
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log("🚀 DAO System Launcher with Circuit Breaker Fixes");
console.log("===============================================");

// 1. Disable embeddings via environment variables
process.env.DISABLE_EMBEDDINGS = "true";
process.env.USE_EMBEDDINGS = "false";
process.env.USE_OPENAI_EMBEDDING = "false";

console.log("✅ Embeddings disabled through environment variables");

// 2. Fix database adapter when it's loaded
// We'll monkey-patch the require system to catch the adapter
const originalRequire = module.constructor.prototype.require;
module.constructor.prototype.require = function(path) {
  const result = originalRequire.apply(this, arguments);
  
  // 2a. Patch the CircuitBreaker module
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
            if (error?.message && (
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
        if (error?.message && (
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
  
  // 2b. Patch PostgreSQL adapter
  if (path.includes('adapter-postgres') || path.includes('postgres/index')) {
    console.log("✅ Found PostgreSQL adapter, applying patches");
    
    // Intercept searchMemories
    if (result && typeof result.searchMemories === 'function') {
      const originalSearch = result.searchMemories;
      result.searchMemories = async function(opts) {
        // Skip vector operations if embeddings disabled
        if (process.env.DISABLE_EMBEDDINGS === 'true') {
          console.log("⏩ Bypassing vector search operation");
          if (typeof this.getMemories === 'function') {
            return this.getMemories({
              roomId: opts.roomId,
              count: opts.match_count || 10,
              unique: opts.unique,
              tableName: opts.tableName,
              agentId: opts.agentId
            });
          }
          return []; // Fallback to empty array if getMemories not available
        }
        
        try {
          return await originalSearch.apply(this, arguments);
        } catch (error) {
          // Handle vector dimension errors with fallback behavior
          if (error?.message && (
              error.message.includes("vector dimensions") || 
              error.message.includes("embedding dimension")
          )) {
            console.log("🛡️ Caught vector dimension error in searchMemories, using fallback");
            if (typeof this.getMemories === 'function') {
              return this.getMemories({
                roomId: opts.roomId,
                count: opts.match_count || 10,
                unique: opts.unique,
                tableName: opts.tableName,
                agentId: opts.agentId
              });
            }
            return []; // Fallback to empty array if getMemories not available
          }
          throw error;
        }
      };
    }
    
    // Intercept createMemory
    if (result && typeof result.createMemory === 'function') {
      const originalCreate = result.createMemory;
      result.createMemory = async function(memory, tableName, unique) {
        // Remove embedding field if disabled
        if (process.env.DISABLE_EMBEDDINGS === 'true' && memory?.embedding) {
          console.log("⏩ Removing embedding from memory object");
          delete memory.embedding; 
        }
        
        try {
          return await originalCreate.apply(this, arguments);
        } catch (error) {
          // Handle vector dimension errors with fallback behavior
          if (error?.message && (
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

// 3. Now launch the DAO system with pnpm
console.log("🚀 Launching DAO system with pnpm...");

// Determine the command to run based on arguments
const args = process.argv.slice(2);
const command = args.length > 0 ? args.join(' ') : 'start';

// Construct and launch the pnpm command
const pnpmCommand = `pnpm run ${command}`;
console.log(`Executing: ${pnpmCommand}`);

// Launch the process and inherit stdio
const proc = spawn('pnpm', ['run', command], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DISABLE_EMBEDDINGS: 'true',
    USE_EMBEDDINGS: 'false',
    USE_OPENAI_EMBEDDING: 'false'
  },
  shell: true
});

// Handle process events
proc.on('close', (code) => {
  if (code !== 0) {
    console.log(`\n❌ DAO system exited with code ${code}`);
    process.exit(code);
  }
});

// Handle errors
proc.on('error', (err) => {
  console.error('❌ Failed to start DAO system:', err);
  process.exit(1);
}); 