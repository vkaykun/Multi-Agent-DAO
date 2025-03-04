# Memory Re-embedding Script

This directory contains utilities for managing and fixing memory embeddings in the DAO system.

## Re-embedding Script

The `reEmbedMemories.js` script re-processes all memories in the database to standardize on 1536-dimensional vectors used by the OpenAI text-embedding-ada-002 model.

### When to Use

Use this script if:

1. You're experiencing vector dimension mismatch errors
2. You're transitioning from a different embedding model (e.g., 384D to 1536D)
3. You want to standardize all embeddings in your database

### Prerequisites

- Node.js 16+
- Access to your PostgreSQL database
- OpenAI API key configured in your `.env.vela` file

### Usage

Run the script using:

```bash
# From the plugin-solana directory
npm run re-embed-memories

# Or directly with ts-node
NODE_OPTIONS="--loader ts-node/esm" ts-node --esm scripts/reEmbedMemories.js
```

### How It Works

The script:

1. Connects to your PostgreSQL database using connection details from `.env.vela`
2. Retrieves memories in batches of 50
3. For each memory:
   - Extracts text content for embedding
   - Generates a new 1536D embedding using OpenAI's text-embedding-ada-002 model
   - Updates the memory in the database with the new embedding
4. Logs progress and results

### Performance Considerations

- The script processes memories in batches to reduce memory usage
- It may take significant time depending on how many memories are in your database
- OpenAI API costs will be incurred for each memory that's re-embedded

### Monitoring

Progress is displayed in the console. If the script is interrupted, you can safely restart it
and it will continue processing from where it left off.

## Compatibility Layer

Note that the DAO system also includes a compatibility layer in `src/shared/fixes/bypass.js`
that can handle vector dimension mismatches on-the-fly. The re-embedding script is a more
permanent solution that updates the database directly. 