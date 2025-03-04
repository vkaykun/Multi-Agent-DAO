// test-vector-fix.js
// Script to test our vector dimension fix

import { convertVector, applyAggressiveVectorFix } from './packages/plugin-solana/src/shared/fixes/vector-fix.js';

// Mock runtime for testing
const mockRuntime = {
  databaseAdapter: {
    addEmbeddingToMemory: async function(memory) {
      console.log(`Original addEmbeddingToMemory called with embedding length: ${memory?.embedding?.length}`);
      if (memory?.embedding?.length !== 1536) {
        throw new Error(`expected 1536 dimensions, not ${memory?.embedding?.length}`);
      }
      return memory;
    },
    pool: {
      query: function(text, params) {
        console.log(`Original query called with ${params?.length} params`);
        return { rows: [] };
      }
    }
  },
  messageManager: {
    createMemory: async function(memory) {
      console.log(`Original createMemory called with embedding length: ${memory?.embedding?.length}`);
      return { id: '123', ...memory };
    },
    searchMemoriesByEmbedding: async function(embedding) {
      console.log(`Original searchMemoriesByEmbedding called with embedding length: ${embedding?.length}`);
      return [];
    }
  }
};

// Test cases for vector conversion
async function runTests() {
  console.log('======== TESTING VECTOR DIMENSION FIX ========');

  // Test 1: Convert a 384D vector to 1536D
  console.log('\n--- Test 1: Convert 384D → 1536D ---');
  const mockVector384 = Array(384).fill(0).map((_, i) => i / 384);
  const converted = convertVector(mockVector384);
  console.log(`Input length: ${mockVector384.length}, Output length: ${converted.length}`);
  console.log(`First few values: [${mockVector384.slice(0, 3).join(', ')}...]`);
  console.log(`First few values (converted): [${converted.slice(0, 3).join(', ')}...]`);
  
  // Test 2: Handle null/undefined
  console.log('\n--- Test 2: Handle null/undefined ---');
  const convertedNull = convertVector(null);
  console.log(`Input: null, Output length: ${convertedNull.length}`);
  
  // Test 3: Apply the fix to the mock runtime
  console.log('\n--- Test 3: Apply fix to mock runtime ---');
  const fixResult = applyAggressiveVectorFix(mockRuntime);
  console.log(`Fix applied: ${fixResult}`);
  
  // Test 4: Test fixed runtime methods with 384D vector
  console.log('\n--- Test 4: Test fixed runtime methods with 384D vector ---');
  
  // Test 4.1: createMemory
  console.log('\n  Testing createMemory...');
  try {
    const result = await mockRuntime.messageManager.createMemory({
      id: 'test-memory',
      embedding: mockVector384,
      content: { text: 'Test memory' }
    });
    console.log(`  Success! Memory created with embedding length: ${result?.embedding?.length}`);
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
  
  // Test 4.2: searchMemoriesByEmbedding
  console.log('\n  Testing searchMemoriesByEmbedding...');
  try {
    await mockRuntime.messageManager.searchMemoriesByEmbedding(mockVector384);
    console.log('  Success! Search completed with dimension conversion');
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
  
  // Test 4.3: addEmbeddingToMemory
  console.log('\n  Testing addEmbeddingToMemory...');
  try {
    const result = await mockRuntime.databaseAdapter.addEmbeddingToMemory({
      id: 'test-memory',
      embedding: mockVector384,
      content: { text: 'Test memory' }
    });
    console.log(`  Success! Embedding added with length: ${result?.embedding?.length}`);
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
  
  console.log('\n======== TESTS COMPLETED ========');
}

// Run the tests
runTests().catch(error => {
  console.error('Test error:', error);
}); 