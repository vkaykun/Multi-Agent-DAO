#!/usr/bin/env node

/**
 * Fix for roomId issue when embeddings are disabled
 * This script patches the memory manager to properly handle the roomId parameter
 */

console.log("🔧 Fixing roomId issue with disabled embeddings");

// Make sure embeddings are disabled
process.env.DISABLE_EMBEDDINGS = "true";
process.env.USE_EMBEDDINGS = "false";

// Function to patch affected modules after they load
function patchModules() {
  // We'll patch the memory manager
  console.log("✅ Preparing to patch memory manager methods");
  
  try {
    // Find the memory manager in the Eliza runtime
    setTimeout(() => {
      const runtime = global.__eliza_runtime;
      
      if (runtime && runtime.messageManager) {
        console.log("✅ Found Eliza runtime and message manager");
        
        // Save original method
        const originalSearchMethod = runtime.messageManager.searchMemoriesByEmbedding;
        
        // Override with fixed method
        runtime.messageManager.searchMemoriesByEmbedding = async function(embedding, opts) {
          console.log("🔄 Using patched searchMemoriesByEmbedding method");
          
          // Check if embeddings are disabled
          if (process.env.DISABLE_EMBEDDINGS === 'true') {
            console.log("⏩ Embeddings disabled, using getMemories fallback with roomId:", opts.roomId);
            
            // Make sure roomId is provided
            if (!opts.roomId) {
              console.error("❌ Missing roomId in searchMemoriesByEmbedding!");
              return []; // Return empty array instead of throwing
            }
            
            // Use getMemories as a fallback with the roomId
            return await this.getMemories({
              roomId: opts.roomId,
              count: opts.count || 10,
              unique: !!opts.unique,
              tableName: this.tableName,
              agentId: this.runtime.agentId
            });
          }
          
          // Otherwise use the original method
          return await originalSearchMethod.call(this, embedding, opts);
        };
        
        console.log("✅ Successfully patched searchMemoriesByEmbedding method");
      } else {
        console.warn("⚠️ Could not find Eliza runtime or message manager");
      }
    }, 3000); // Wait 3 seconds for initialization
  } catch (error) {
    console.error("❌ Error patching memory manager:", error);
  }
}

// Execute the patch
patchModules();

console.log("✅ Setup complete - run with: NODE_OPTIONS=\"--require ./fix-roomid.js\" pnpm start:vela"); 