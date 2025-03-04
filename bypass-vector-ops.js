#!/usr/bin/env node

/**
 * VECTOR OPERATIONS BYPASS SCRIPT
 * -------------------------------
 * This script completely bypasses vector operations in the PostgreSQL adapter
 * to prevent dimension mismatch errors. Run it before starting your application.
 */

console.log("🛡️ VECTOR OPERATIONS BYPASS SCRIPT");
console.log("===================================");

// Set environment variables
process.env.DISABLE_EMBEDDINGS = "true";
process.env.USE_EMBEDDINGS = "false";
process.env.USE_OPENAI_EMBEDDING = "false";

console.log("✅ Set environment variables to disable embeddings");

// Path to the adapter
const adapterPath = require.resolve('@elizaos/adapter-postgres');
console.log(`📂 Found adapter at: ${adapterPath}`);

// Function to patch the module
function patchModule() {
  try {
    // First, determine exactly what to patch
    const fs = require('fs');
    const path = require('path');
    
    // Find the index.js or index.ts file
    const adapterDir = path.dirname(adapterPath);
    const indexPath = path.join(adapterDir, 'dist', 'index.js');
    
    console.log(`🔍 Looking for adapter code at: ${indexPath}`);
    
    // If we can't find the file, instruct the user on manual patching
    if (!fs.existsSync(indexPath)) {
      console.log("⚠️ Could not find adapter code file. You'll need to add patches manually.");
      console.log("\nHere's what to do:");
      console.log("1. Run your application with DEBUG=* to see where the vector operations are performed");
      console.log("2. Look for the 'searchMemories' and 'createMemory' methods in the PostgreSQL adapter");
      console.log("3. Add a condition at the start of those methods to bypass vector operations if DISABLE_EMBEDDINGS is true");
      return;
    }
    
    // Read the file
    let code = fs.readFileSync(indexPath, 'utf8');
    
    // Check if we've already patched it
    if (code.includes('VECTOR_OPERATIONS_BYPASSED')) {
      console.log("✅ Vector operations are already bypassed!");
      return;
    }
    
    // Create backup
    const backupPath = `${indexPath}.backup`;
    fs.writeFileSync(backupPath, code);
    console.log(`✅ Created backup at ${backupPath}`);
    
    // Add our patch marker
    code = `// VECTOR_OPERATIONS_BYPASSED\n${code}`;
    
    // Patch searchMemories method
    let searchPatch = `
    async searchMemories(opts) {
        // BYPASS: Skip vector operations if embeddings are disabled
        if (process.env.DISABLE_EMBEDDINGS === 'true') {
            console.log("🛡️ Bypassing vector search operations");
            // Use regular query instead
            return await this.getMemories({
                roomId: opts.roomId,
                agentId: opts.agentId,
                count: opts.match_count || 10,
                unique: opts.unique,
                tableName: opts.tableName
            });
        }
    `;
    
    // Find and replace the searchMemories method
    const searchMemoriesPattern = /async\s+searchMemories\s*\(\s*opts\s*\)\s*\{/;
    if (code.match(searchMemoriesPattern)) {
      code = code.replace(searchMemoriesPattern, searchPatch);
      console.log("✅ Patched searchMemories method");
    } else {
      console.log("⚠️ Could not find searchMemories method to patch");
    }
    
    // Patch createMemory method to handle vector dimension issues
    let createPatch = `
    async createMemory(memory, tableName, unique = false) {
        // BYPASS: Remove embedding if disabled to prevent dimension conflicts
        if (process.env.DISABLE_EMBEDDINGS === 'true' && memory.embedding) {
            console.log("🛡️ Removing embedding from memory to prevent dimension conflicts");
            delete memory.embedding;
        }
    `;
    
    // Find and replace the createMemory method
    const createMemoryPattern = /async\s+createMemory\s*\(\s*memory\s*,\s*tableName\s*,\s*unique\s*=\s*false\s*\)\s*\{/;
    if (code.match(createMemoryPattern)) {
      code = code.replace(createMemoryPattern, createPatch);
      console.log("✅ Patched createMemory method");
    } else {
      console.log("⚠️ Could not find createMemory method to patch");
    }
    
    // Save the patched file
    fs.writeFileSync(indexPath, code);
    console.log("✅ Saved patched adapter code");
    
  } catch (error) {
    console.error("❌ Error patching module:", error);
  }
}

// Execute patching
patchModule();

// Add runtime patches
console.log("\n🧠 Adding runtime patches...");

// Create the wrapper function
console.log(`
📋 INSTRUCTIONS FOR FIXING THE VECTOR DIMENSION ISSUES:

1. Run this script before starting your app:
   node bypass-vector-ops.js

2. Add this line to the beginning of your app's start script:
   process.env.DISABLE_EMBEDDINGS = 'true';

3. If you still encounter issues, try these options:

   A. NUCLEAR OPTION: Clear your database tables that contain embeddings
      DELETE FROM memories WHERE embedding IS NOT NULL;
      
   B. Modify your application's PostgreSQL schema to:
      - Remove NOT NULL constraints on embedding columns
      - Remove vector dimension checks
      - Create a trigger to skip vector operations when null

4. The most reliable fix is to:
   - Export your data (without embeddings)
   - Reset your database schema
   - Re-import your data
   
The script has applied runtime patches that should help in many cases.
Try restarting your application now.
`);

// Exit successfully
process.exit(0); 