#!/bin/bash

# Special startup script for Vela that applies all our fixes

# Set up environment variables to disable embeddings
export DISABLE_EMBEDDINGS=true
export USE_EMBEDDINGS=false

echo "🔧 Starting Vela with embedding fixes..."

# Create a fixes directory in the root
echo "📝 Creating fixes directory..."
mkdir -p fixes

# Create bypass script directly in the project root
echo "📝 Creating bypass script..."
cat > fixes/bypass.js << 'EOF'
// Runtime fix for roomId issues
process.env.DISABLE_EMBEDDINGS = "true";
process.env.USE_EMBEDDINGS = "false";

// Make our fix run early
setTimeout(() => {
  console.log("🔧 Applying runtime fixes for embeddings...");
  
  try {
    // Fix searchMemoriesByEmbedding to handle missing roomId
    const runtime = global.__eliza_runtime;
    if (runtime && runtime.messageManager) {
      // Original method
      const originalSearch = runtime.messageManager.searchMemoriesByEmbedding;
      
      // Override
      runtime.messageManager.searchMemoriesByEmbedding = async function(embedding, opts) {
        // If embeddings disabled, handle missing roomId
        if (process.env.DISABLE_EMBEDDINGS === 'true') {
          if (!opts || !opts.roomId) {
            console.log("⚠️ Missing roomId in searchMemoriesByEmbedding, returning empty array");
            return [];
          }
        }
        // Call original with all expected params
        return await originalSearch.call(this, embedding, opts);
      };
      
      console.log("✅ Applied searchMemoriesByEmbedding fix");
    } else {
      console.log("⚠️ Could not find runtime or message manager to patch");
      
      // Try to find it differently - via global modules
      const allGlobals = Object.keys(global);
      console.log("Looking through global objects:", allGlobals.length);
      
      for (const key of allGlobals) {
        const obj = global[key];
        if (obj && typeof obj === 'object' && obj.messageManager && typeof obj.messageManager.searchMemoriesByEmbedding === 'function') {
          console.log("✅ Found alternative runtime object:", key);
          
          // Apply fix here too
          const originalSearch = obj.messageManager.searchMemoriesByEmbedding;
          
          obj.messageManager.searchMemoriesByEmbedding = async function(embedding, opts) {
            // If embeddings disabled, handle missing roomId
            if (process.env.DISABLE_EMBEDDINGS === 'true') {
              if (!opts || !opts.roomId) {
                console.log("⚠️ Missing roomId in searchMemoriesByEmbedding, returning empty array");
                return [];
              }
            }
            // Call original with all expected params
            return await originalSearch.call(this, embedding, opts);
          };
          
          console.log("✅ Applied searchMemoriesByEmbedding fix to alternative object");
        }
      }
    }
    
    // Also patch the PostgreSQL adapter if it's in memory
    const pgAdapter = require('@elizaos/adapter-postgres');
    if (pgAdapter && pgAdapter.PostgresDatabaseAdapter && pgAdapter.PostgresDatabaseAdapter.prototype) {
      console.log("✅ Found PostgreSQL adapter to patch");
      
      // Save original method
      const originalGetMemories = pgAdapter.PostgresDatabaseAdapter.prototype.getMemories;
      
      // Override with our fixed version
      pgAdapter.PostgresDatabaseAdapter.prototype.getMemories = function(params) {
        if (!params.tableName) throw new Error("tableName is required");
        if (!params.roomId) {
            if (process.env.DISABLE_EMBEDDINGS === 'true') {
                console.log("⚠️ Missing roomId in getMemories with embeddings disabled, returning empty array");
                return Promise.resolve([]);
            }
            throw new Error("roomId is required");
        }
        
        return originalGetMemories.call(this, params);
      };
      
      console.log("✅ Applied PostgreSQL adapter fix");
    }
  } catch (error) {
    console.error("❌ Error applying embedding fixes:", error);
  }
}, 1000);
EOF

# Start Vela with our bypass script
echo "🚀 Starting Vela..."
cd packages/plugin-solana
DISABLE_EMBEDDINGS=true NODE_OPTIONS="--require ../../fixes/bypass.js --no-deprecation" pnpm start:vela 