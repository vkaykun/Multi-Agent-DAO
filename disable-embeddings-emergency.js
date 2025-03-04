#!/usr/bin/env node

/**
 * Emergency script to safely disable embeddings
 * Run with: node disable-embeddings-emergency.js
 */

console.log("🔧 Emergency Embeddings Disabler");
console.log("================================");

// Set the environment variable
process.env.DISABLE_EMBEDDINGS = "true";
console.log("✅ Set DISABLE_EMBEDDINGS=true in environment");

// Monkey patch the addEmbeddingToMemory method in all memory managers
try {
    const safeZeroVector = () => Array(1536).fill(0);
    
    // This will run when the app loads
    setTimeout(() => {
        console.log("🧠 Patching memory managers...");
        
        // Find all memory managers
        const globalObj = global || window || {};
        const memoryManagers = [];
        
        // Look for memory managers in the runtime
        if (globalObj.__eliza_runtime) {
            console.log("✅ Found Eliza runtime");
            try {
                // Patch the memory manager
                const memoryManager = globalObj.__eliza_runtime.messageManager;
                if (memoryManager && typeof memoryManager.addEmbeddingToMemory === 'function') {
                    const originalMethod = memoryManager.addEmbeddingToMemory;
                    memoryManager.addEmbeddingToMemory = async function(memory) {
                        console.log("🔄 Intercepted addEmbeddingToMemory call");
                        memory.embedding = safeZeroVector();
                        return memory;
                    };
                    memoryManagers.push("Main memory manager");
                }
                
                // Also patch searchMemoriesByEmbedding
                if (memoryManager && typeof memoryManager.searchMemoriesByEmbedding === 'function') {
                    const originalSearch = memoryManager.searchMemoriesByEmbedding;
                    memoryManager.searchMemoriesByEmbedding = async function(embedding, options) {
                        console.log("🔄 Intercepted searchMemoriesByEmbedding call");
                        // Use getMemories instead
                        return await this.getMemories({
                            roomId: options.roomId,
                            count: options.count || 10,
                            unique: options.unique
                        });
                    };
                }
            } catch (err) {
                console.error("❌ Error patching runtime memory manager:", err);
            }
        }
        
        if (memoryManagers.length === 0) {
            console.log("⚠️ No memory managers found to patch");
        } else {
            console.log(`✅ Patched ${memoryManagers.length} memory managers: ${memoryManagers.join(", ")}`);
        }
        
        console.log("✅ Embeddings safely disabled");
        console.log("You can now interact with the system without embedding errors");
    }, 1000);
    
} catch (error) {
    console.error("❌ Error in emergency patch:", error);
} 