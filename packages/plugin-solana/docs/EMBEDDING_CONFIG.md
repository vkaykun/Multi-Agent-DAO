# Embedding Configuration Guide

## Overview

This document explains how to properly configure embeddings for your Eliza agents to ensure optimal memory retrieval performance. Embeddings are crucial for maintaining conversational context and ensuring agents respond to the most recent user messages accurately.

## The "One Message Behind" Problem

If your agent appears to be answering questions from the previous message rather than the current one, it may be due to disabled embeddings or suboptimal memory retrieval. This symptom occurs because:

1. Without embeddings, the agent falls back to simpler database queries that may not prioritize the most recent messages
2. The fallback logic may return stale/older messages instead of the current user query
3. This leads to agents responding to previous questions rather than the current one

## Recommended Configuration

For optimal performance with robust context awareness, use these environment settings:

```bash
# Enable embeddings for semantic search
DISABLE_EMBEDDINGS=false
USE_EMBEDDINGS=true
USE_OPENAI_EMBEDDING=true
EMBEDDING_OPENAI_MODEL=text-embedding-ada-002
```

Add these to your `.env.vela`, `.env.pion`, `.env.kron`, and `.env.nova` files for all agents.

## Recent Fixes

We've implemented multiple reinforcements to ensure proper message handling:

1. **Room ID Standardization**: All messages are now stored and retrieved with a standardized room ID (`CONVERSATION_ROOM_ID`)
2. **Enhanced Fallback Logic**: When embeddings are disabled, the fallback now:
   - Retrieves more messages initially (50 instead of 30)
   - Applies better filtering to remove system messages
   - Ensures proper sorting by timestamp
   - Preserves the most recent user message even when slicing

3. **Memory Preservation**: We ensure the most recent user message is never sliced away during context building

4. **Levenshtein Error Handling**: We've added robust handling for database Levenshtein errors:
   - Content is automatically truncated to 250 characters before Levenshtein calculations
   - If errors still occur, we gracefully fall back to timestamp-based retrieval
   - This prevents database errors from disrupting the conversation flow

## Performance vs Accuracy Trade-offs

### High-Accuracy Configuration (Recommended)
```bash
DISABLE_EMBEDDINGS=false
USE_EMBEDDINGS=true
USE_OPENAI_EMBEDDING=true
EMBEDDING_OPENAI_MODEL=text-embedding-ada-002
```
- **Pros**: Best context awareness, proper response to latest messages
- **Cons**: Higher computational cost, slight latency increase
- **Use when**: User experience quality is paramount

### Low-Resource Configuration
```bash
DISABLE_EMBEDDINGS=true
USE_EMBEDDINGS=false
```
- **Pros**: Lower computational overhead, faster initial responses
- **Cons**: May experience "one message behind" issues occasionally
- **Use when**: Running on very constrained hardware or when perfect context is less critical

## Troubleshooting

If you experience "out of sync" or "one message behind" issues:

1. Verify your `.env` files have the recommended configuration above
2. Check your logs for any of these messages:
   - "Embeddings disabled, using enhanced fallback retrieval"
   - "Using fallback roomId"
   - "Standardizing roomId in searchMemoriesByEmbedding"
3. Look for diagnostic outputs showing whether the current message is included:
   - "Final memory count: X, includes most recent user message: true/false"
   - "Context includes current message: true/false"
4. Update to the latest version of the codebase which includes enhanced fallback logic
5. If issues persist, use the tools in `MEMORY_DIAGNOSTICS.md` to trace the pipeline

## Levenshtein Database Errors

If you see errors like this in your logs:
```
ERROR: Error in getCachedEmbeddings:
    error: "levenshtein argument exceeds maximum length of 255 characters"
```

These are caused by PostgreSQL's Levenshtein function having a 255 character limit. Our system now handles these errors with:

1. **Preventive truncation** in `memory.ts` that limits content to 250 characters before Levenshtein calculations
2. **Error catching** in `bypass.js` that switches to timestamp-based retrieval if errors still occur
3. **Graceful degradation** that ensures conversation continuity even when embedding errors happen

You should see these log messages when the error handling is working:
```
⚠️ Caught Levenshtein error in searchMemoriesByEmbedding, using fallback retrieval
Retrieved X memories using Levenshtein error fallback
```

## Message Slicing Protection

Our improved fallback system now protects against message slicing issues:

1. We track the most recent user message during filtering
2. After slicing, we check if that message was preserved
3. If not, we manually add it back to the context
4. This ensures the current message is always included in the context

## Technical Details

Our system uses two primary approaches for memory retrieval:

1. **Embedding-based semantic search** (preferred): Finds memories semantically similar to the current context
2. **Fallback retrieval** (when embeddings disabled): Uses direct database queries sorted by timestamp

The fallback approach has been enhanced to better prioritize recent messages, but it's still recommended to use embeddings for optimal results.

## Common Patterns in Logs

When embeddings are enabled (good):
```
✅ Applied searchMemoriesByEmbedding fix with improved fallback logic and Levenshtein error handling
Generating embedding for: [user message text]
Retrieved 15 memories with semantic search
```

When embeddings are disabled (using improved fallback):
```
📋 Using improved fallback retrieval for disabled embeddings
Retrieved 30 memories using improved fallback
Filtered to 18 relevant messages
Final memory count: 19, includes most recent user message: true
```

When Levenshtein errors are handled:
```
⚠️ Caught Levenshtein error in searchMemoriesByEmbedding, using fallback retrieval
Retrieved 25 memories using Levenshtein error fallback
Returning 20 memories from Levenshtein error fallback
```

## Diagnostics and Monitoring

For detailed diagnostics about your memory pipeline, refer to `MEMORY_DIAGNOSTICS.md`. This guide provides step-by-step instructions for verifying your memory retrieval and context building processes.

Always check for your agent's final output that confirms it's responding to the current message rather than previous ones. 