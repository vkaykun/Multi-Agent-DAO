#!/bin/bash
# Safe startup script that handles vector dimension issues

echo "🚀 Starting DAO system with vector operation safety..."

# Check if original command was provided
if [ $# -eq 0 ]; then
  ORIGINAL_CMD="npm start"
else
  ORIGINAL_CMD="$@"
fi

# Set environment variables
export DISABLE_EMBEDDINGS=true
export USE_EMBEDDINGS=false
export USE_OPENAI_EMBEDDING=false

echo "✅ Embeddings disabled via environment variables"

# Run vector bypass script
if [ -f ./bypass-vector-ops.js ]; then
  echo "🛡️ Running vector bypass script..."
  node bypass-vector-ops.js
else
  echo "⚠️ Vector bypass script not found, continuing without it"
fi

# Run the circuit breaker fix script
if [ -f ./vector-dimension-fix.js ]; then
  echo "🛡️ Installing circuit breaker fix..."
  chmod +x ./vector-dimension-fix.js
  
  # Check if NODE_OPTIONS already contains -r
  if [[ "$NODE_OPTIONS" == *"-r"* ]]; then
    # Append to existing requires
    export NODE_OPTIONS="$NODE_OPTIONS -r ./vector-dimension-fix.js"
  else
    # Set fresh require
    export NODE_OPTIONS="-r ./vector-dimension-fix.js"
  fi
  
  echo "✅ Circuit breaker fix installed via NODE_OPTIONS"
else
  echo "⚠️ Circuit breaker fix script not found, continuing without it"
fi

# Print guidance
echo ""
echo "If you still encounter 'different vector dimensions' errors:"
echo "1. Run the SQL fix: psql -U your_user -d your_database -f fix-vector-dimensions.sql"
echo "2. Or clear all embeddings: psql -U your_user -d your_database -f clear-all-embeddings.sql"
echo ""

# Execute the original command
echo "🚀 Executing: $ORIGINAL_CMD"
eval "$ORIGINAL_CMD" 