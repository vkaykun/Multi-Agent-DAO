#!/bin/bash

# Set environment variables for vector dimension fixes
export DISABLE_EMBEDDINGS=true
export USE_EMBEDDINGS=false
export USE_OPENAI_EMBEDDING=false

# Print info
echo "🚀 Starting Vela with vector fixes..."

# Change directory to plugin-solana
cd packages/plugin-solana

# Run with runtime patches
NODE_OPTIONS="--require ../../dao-start.js --loader ts-node/esm" ts-node --esm src/startVela.ts

# The script above will:
# 1. Load our fixes before any other modules
# 2. Start Vela agent directly with ts-node
# 3. Apply our circuit breaker and vector dimension fixes 