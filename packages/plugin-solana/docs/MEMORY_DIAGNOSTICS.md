# Memory Diagnostics Guide

This document provides troubleshooting steps to verify that your memory retrieval and embedding system is working correctly.

## Overview of Memory Pipeline

The memory pipeline consists of these key steps:
1. User message storage (in a consistent room ID)
2. Memory retrieval (via embeddings or fallback)
3. Memory filtering and prioritization
4. Context assembly for the AI

If any step fails, your bot may exhibit "memory loss" or appear to be one message behind.

## Checking Memory Retrieval Execution

### Step 1: Verify Logs Show Fallback Execution

When the system is running, check for these log messages to confirm the fallback is executing:

```
🔧 Applying runtime fixes for embeddings...
✅ Applied searchMemoriesByEmbedding fix with improved fallback logic and Levenshtein error handling
📋 Using improved fallback retrieval for disabled embeddings
Retrieved X memories using improved fallback
Filtered to Y relevant messages
```

If these logs are not appearing, your fallback is not being called, which might be caused by:
- Another patch that overrides `searchMemoriesByEmbedding` later in the boot sequence
- A code path that bypasses memory retrieval entirely
- Environment variable `DISABLE_EMBEDDINGS` not set correctly

### Step 2: Add Diagnostic Logging

Insert this code in `packages/plugin-solana/src/agents/treasury/messageHandler.ts` to verify memory contents before context assembly:

```typescript
// Add at the beginning of handleGeneralConversation
console.log("🔍 Starting message handler for:", message.content.text?.substring(0, 50));

// Add right after retrieveRelevantMemories call
console.log(`📋 Retrieved ${memories.length} memories for context building`);
if (memories.length > 0) {
  // Log the most recent memories (newest first)
  console.log("📝 Most recent messages in context:");
  memories.slice(0, 3).forEach((mem, i) => {
    console.log(`  ${i}: ${mem.content.type} | ${mem.content.text?.substring(0, 50)}... | ${new Date(mem.content.createdAt).toISOString()}`);
  });
}

// Add right before the LLM call
console.log(`🧠 Final context length: ${context.length} characters, includes current message: ${context.includes(message.content.text || '')}`);
```

### Step 3: Check the Final Context

The final context assembly is a critical point. Look for these log patterns:

```
🧠 Final context length: 10238 characters, includes current message: true
```

If it shows `includes current message: false`, your memory retrieval worked but the context assembly failed to include the current message.

## Levenshtein Error Handling

PostgreSQL's Levenshtein function has a maximum character limit of 255 characters. When this limit is exceeded, you'll see errors like:

```
ERROR: Error in getCachedEmbeddings:
    tableName: "messages"
    fieldName: "content"
    error: "levenshtein argument exceeds maximum length of 255 characters"
```

Our system now handles these errors in two ways:

1. **Preventive Truncation**: The `truncateForLevenshtein` function in `memory.ts` automatically truncates content to 250 characters before sending it to the database for Levenshtein calculations.

2. **Fallback Mechanism**: If a Levenshtein error still occurs, `bypass.js` catches it and switches to a timestamp-based fallback retrieval method similar to when embeddings are disabled.

### Diagnosing Levenshtein Issues

Look for these log patterns to confirm the Levenshtein error handling is working:

```
⚠️ Caught Levenshtein error in searchMemoriesByEmbedding, using fallback retrieval
Retrieved X memories using Levenshtein error fallback
Returning Y memories from Levenshtein error fallback
```

If you see the original error but not these fallback logs, it means the error handling is not being triggered. Check that:

1. The latest version of `bypass.js` is being loaded
2. The error is actually a Levenshtein error (check the exact error message)
3. The fallback mechanism is properly implemented

## Room ID Consistency Checks

Room ID inconsistency is a common cause of memory retrieval failures. Verify these log patterns:

```
🔄 Standardizing roomId in searchMemoriesByEmbedding: [originalRoomId] → [standardizedRoomId]
Storing message with standardized room ID
```

If you see different room IDs used for storage versus retrieval, this indicates a problem with room ID standardization.

## Database Integrity Check

Run this query against your database to verify memory storage integrity:

```sql
SELECT content->>'type' as type, 
       COUNT(*) as count, 
       MIN(content->>'createdAt') as oldest, 
       MAX(content->>'createdAt') as newest
FROM memories 
GROUP BY content->>'type'
ORDER BY count DESC;
```

This will show how many memories of each type exist and their age range.

## Setting Check

Ensure these settings are configured consistently across all `.env` files:

```
# Required for embeddings to work
EMBEDDING_OPENAI_MODEL=text-embedding-ada-002
USE_OPENAI_EMBEDDING=true
DISABLE_EMBEDDINGS=false
USE_EMBEDDINGS=true
```

## Testing the Memory Pipeline

To test if the memory pipeline is working end-to-end:

1. Send a unique message like "The purple elephant dances at midnight"
2. Check logs to verify:
   - The message is stored with a standardized room ID
   - The message is retrieved in the memory context
   - The message appears in the final context
3. Send a follow-up message referencing the first: "Why was that elephant dancing?"
4. Check if the response acknowledges the previous message

If the system fails to maintain context, trace which step in the pipeline is failing using the diagnostic logs.

## Special Case: Slice Issue

Our improved fallback logic in `bypass.js` ensures that even when slicing memories to fit the context, the most recent user message is always preserved. Check these logs to confirm this mechanism is working:

```
🔍 Adding most recent user message to results that was excluded by slice
Final memory count: X, includes most recent user message: true
```

If you don't see these logs when they should appear, investigate the slicing logic in the fallback implementation. 