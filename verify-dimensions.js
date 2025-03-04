// verify-dimensions.js
// Script to verify vector dimension implementations across the codebase

const fs = require('fs');
const path = require('path');

// Verify core implementations
console.log('=== VECTOR DIMENSION VERIFICATION ===');

// Check getEmbeddingZeroVector implementation
const embeddingPath = path.resolve('./packages/core/src/embedding.ts');
if (fs.existsSync(embeddingPath)) {
  const embeddingFile = fs.readFileSync(embeddingPath, 'utf8');
  const zeroVectorMatch = embeddingFile.match(/getEmbeddingZeroVector[^{]*{([^}]*)}/s);
  if (zeroVectorMatch) {
    console.log('getEmbeddingZeroVector implementation:');
    console.log(zeroVectorMatch[0].trim());
  } else {
    console.log('Could not find getEmbeddingZeroVector implementation');
  }
} else {
  console.log(`File not found: ${embeddingPath}`);
}

// Check database helper implementation
const dbHelperPath = path.resolve('./packages/plugin-solana/src/shared/utils/database-helper.ts');
if (fs.existsSync(dbHelperPath)) {
  const dbHelperFile = fs.readFileSync(dbHelperPath, 'utf8');
  const safeZeroVectorMatch = dbHelperFile.match(/getSafeZeroVector[^{]*{([^}]*)}/s);
  if (safeZeroVectorMatch) {
    console.log('\ngetSafeZeroVector implementation:');
    console.log(safeZeroVectorMatch[0].trim());
  } else {
    console.log('Could not find getSafeZeroVector implementation');
  }
} else {
  console.log(`File not found: ${dbHelperPath}`);
}

// Check emergency disabler script
const disablerPath = path.resolve('./disable-embeddings-emergency.js');
if (fs.existsSync(disablerPath)) {
  const disablerFile = fs.readFileSync(disablerPath, 'utf8');
  const safeZeroVectorMatch = disablerFile.match(/safeZeroVector[^=]+=([^;]*);/);
  if (safeZeroVectorMatch) {
    console.log('\nsafeZeroVector implementation in emergency disabler:');
    console.log('safeZeroVector' + safeZeroVectorMatch[0].trim());
  } else {
    console.log('Could not find safeZeroVector implementation in emergency disabler');
  }
} else {
  console.log(`File not found: ${disablerPath}`);
}

console.log('\nAll checks complete!'); 