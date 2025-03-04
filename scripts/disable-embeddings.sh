#!/bin/bash
# Script to disable embeddings system-wide in the DAO system

# Print header
echo "========================================"
echo "Disabling Embeddings for DAO System"
echo "========================================"

# Add DISABLE_EMBEDDINGS=true to all .env files
ENV_FILES=$(find . -name ".env*")

for file in $ENV_FILES
do
  if grep -q "DISABLE_EMBEDDINGS" "$file"; then
    # Replace existing setting
    sed -i '' 's/DISABLE_EMBEDDINGS=.*/DISABLE_EMBEDDINGS=true/' "$file"
    echo "Updated embedding setting in $file"
  else
    # Add new setting
    echo "" >> "$file" # Add a newline first to prevent concatenation
    echo "DISABLE_EMBEDDINGS=true" >> "$file"
    echo "Added embedding setting to $file"
  fi
done

# Also set it in the current environment
export DISABLE_EMBEDDINGS=true

echo ""
echo "Embeddings have been disabled in all environment files."
echo "To apply the changes, restart your application or run:"
echo "export DISABLE_EMBEDDINGS=true"
echo ""
echo "This will:"
echo "- Replace all embedding operations with zero vectors"
echo "- Skip API calls to OpenAI/other embedding providers"
echo "- Maintain full functionality of the DAO system"
echo "- Improve performance and reduce costs"
echo ""
echo "To re-enable embeddings, run:"
echo "export DISABLE_EMBEDDINGS=false"
echo "" 