// upgrade-embeddings.js
// Script to upgrade 384D vectors to 1536D vectors and fix any dimension mismatches

import pkg from 'pg';
const { Client } = pkg;
import dotenvPkg from 'dotenv';
const dotenv = dotenvPkg.default || dotenvPkg;
import pathPkg from 'path';
const path = pathPkg.default || pathPkg;
import { OpenAI } from 'openai';

// Load environment variables (adjust path as needed for your project)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Constants
const TARGET_DIMENSION = 1536;
const EMBEDDING_MODEL = process.env.EMBEDDING_OPENAI_MODEL || 'text-embedding-ada-002';
const BATCH_SIZE = 30;
const OLD_DIMENSION = 384; // The dimension we're replacing

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize PostgreSQL client
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

/**
 * Generate embedding using OpenAI API
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - The embedding vector
 */
async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8191), // OpenAI's text limit
    });
    
    return response.data[0].embedding;
  } catch (error) {
    console.error(`Error generating embedding: ${error.message}`);
    return null;
  }
}

/**
 * Convert a 384D vector to 1536D by repeating values or padding
 * @param {number[]} vector - The vector to convert
 * @returns {number[]} - The 1536D vector
 */
function convert384To1536(vector) {
  if (!vector || !Array.isArray(vector)) {
    console.error(`Invalid vector: ${typeof vector}`);
    return Array(TARGET_DIMENSION).fill(0);
  }
  
  const dimension = vector.length;
  
  if (dimension === TARGET_DIMENSION) {
    return vector; // Already correct dimension
  }
  
  // For 384D vectors, repeat each value 4 times to get to 1536
  if (dimension === OLD_DIMENSION) {
    const result = [];
    for (let i = 0; i < dimension; i++) {
      // Repeat each value 4 times
      result.push(vector[i]);
      result.push(vector[i]);
      result.push(vector[i]);
      result.push(vector[i]);
    }
    return result;
  }
  
  // For other dimensions, pad with zeros or truncate
  if (dimension < TARGET_DIMENSION) {
    return [...vector, ...Array(TARGET_DIMENSION - dimension).fill(0)];
  } else {
    return vector.slice(0, TARGET_DIMENSION);
  }
}

/**
 * Extract text from memory content for embedding
 */
function extractTextForEmbedding(content) {
  try {
    if (!content) return '';
    
    // Parse content if it's a string
    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    
    // Extract text based on available fields
    if (contentObj.text) return contentObj.text;
    if (contentObj.message) return contentObj.message;
    if (contentObj.title) return `${contentObj.title} ${contentObj.description || ''}`;
    if (contentObj.description) return contentObj.description;
    
    // Fallback to stringified content
    return JSON.stringify(contentObj).substring(0, 1000);
  } catch (error) {
    console.error(`Error extracting text: ${error.message}`);
    return '';
  }
}

/**
 * Detect embedding dimension for a memory
 */
async function detectEmbeddingDimension(id) {
  try {
    const result = await pgClient.query(
      'SELECT array_length(embedding, 1) as dimension FROM memories WHERE id = $1 AND embedding IS NOT NULL',
      [id]
    );
    
    if (result.rows.length === 0 || !result.rows[0].dimension) {
      return 0; // No embedding or NULL
    }
    
    return parseInt(result.rows[0].dimension);
  } catch (error) {
    console.error(`Error detecting dimension for memory ${id}: ${error.message}`);
    return -1; // Error
  }
}

/**
 * Find memories with mismatched embedding dimensions
 */
async function findMismatchedEmbeddings() {
  console.log(`Finding embeddings with dimension ${OLD_DIMENSION}...`);
  
  try {
    // First check if we can use array_length
    try {
      const result = await pgClient.query(
        `SELECT id, content, array_length(embedding, 1) as dimension 
         FROM memories 
         WHERE embedding IS NOT NULL 
         AND array_length(embedding, 1) != $1
         ORDER BY "createdAt"`,
        [TARGET_DIMENSION]
      );
      
      const mismatchedMemories = result.rows.filter(row => row.dimension !== null);
      
      console.log(`Found ${mismatchedMemories.length} memories with mismatched dimensions:`);
      
      // Group by dimension
      const dimensionCounts = {};
      mismatchedMemories.forEach(row => {
        dimensionCounts[row.dimension] = (dimensionCounts[row.dimension] || 0) + 1;
      });
      
      console.log('Dimension distribution:');
      Object.entries(dimensionCounts).forEach(([dimension, count]) => {
        console.log(`  - ${dimension}D: ${count} memories`);
      });
      
      return mismatchedMemories;
    } catch (error) {
      console.log('Error using array_length function, trying alternative approach');
      console.error(error);
      
      // Alternative approach: Check the first few memories and manually verify dimensions
      const result = await pgClient.query(
        `SELECT id, content, embedding FROM memories 
         WHERE embedding IS NOT NULL 
         ORDER BY "createdAt" 
         LIMIT 300`
      );
      
      // Filter memories with mismatched dimensions
      const mismatchedMemories = result.rows.filter(row => {
        if (!Array.isArray(row.embedding)) return false;
        return row.embedding.length !== TARGET_DIMENSION;
      });
      
      console.log(`Found ${mismatchedMemories.length} memories with mismatched dimensions out of ${result.rows.length} checked`);
      return mismatchedMemories.map(row => ({ 
        id: row.id, 
        content: row.content,
        dimension: Array.isArray(row.embedding) ? row.embedding.length : 0
      }));
    }
  } catch (error) {
    console.error(`Error finding mismatched embeddings: ${error.message}`);
    return [];
  }
}

/**
 * Update memory with new embedding
 */
async function updateMemoryEmbedding(id, embedding) {
  try {
    await pgClient.query(
      'UPDATE memories SET embedding = $1 WHERE id = $2',
      [embedding, id]
    );
    return true;
  } catch (error) {
    console.error(`Error updating memory ${id}: ${error.message}`);
    return false;
  }
}

/**
 * Clear embeddings for specific memories
 */
async function clearEmbeddings(memoryIds) {
  if (!memoryIds.length) return 0;
  
  try {
    const result = await pgClient.query(
      'UPDATE memories SET embedding = NULL WHERE id = ANY($1)',
      [memoryIds]
    );
    
    return result.rowCount;
  } catch (error) {
    console.error(`Error clearing embeddings: ${error.message}`);
    return 0;
  }
}

/**
 * Main function to fix dimension mismatches
 */
async function fixDimensionMismatches() {
  try {
    console.log('Connecting to database...');
    await pgClient.connect();
    
    console.log('Checking database connection...');
    await pgClient.query('SELECT NOW()');
    
    // Check database schema version
    try {
      const pgvectorResult = await pgClient.query(`
        SELECT extversion FROM pg_extension WHERE extname = 'vector'
      `);
      
      if (pgvectorResult.rows.length > 0) {
        console.log(`pgvector extension version: ${pgvectorResult.rows[0].extversion}`);
      } else {
        console.log('pgvector extension not found');
      }
    } catch (error) {
      console.log('Unable to check pgvector extension version');
    }
    
    // Find mismatched embeddings
    const mismatchedMemories = await findMismatchedEmbeddings();
    
    if (mismatchedMemories.length === 0) {
      console.log('No dimension mismatches found. Exiting.');
      return;
    }
    
    console.log(`Processing ${mismatchedMemories.length} memories with mismatched dimensions...`);
    
    // Process in batches
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let noText = 0;
    let regeneFixed = 0;
    let convertFixed = 0;
    
    for (let i = 0; i < mismatchedMemories.length; i += BATCH_SIZE) {
      const batch = mismatchedMemories.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${i/BATCH_SIZE + 1}/${Math.ceil(mismatchedMemories.length/BATCH_SIZE)}...`);
      
      // Process each memory in the batch
      for (const memory of batch) {
        processed++;
        const text = extractTextForEmbedding(memory.content);
        
        if (!text || text.length < 3) {
          console.log(`Skipping memory ${memory.id} - insufficient text`);
          noText++;
          continue;
        }
        
        // First try to regenerate the embedding
        const embedding = await generateEmbedding(text);
        
        // Check if regeneration worked
        if (embedding && embedding.length === TARGET_DIMENSION) {
          const success = await updateMemoryEmbedding(memory.id, embedding);
          if (success) {
            regeneFixed++;
            succeeded++;
            console.log(`Regenerated embedding for memory ${memory.id}`);
          } else {
            failed++;
          }
        } 
        // If regeneration failed, try conversion method for 384D vectors
        else if (memory.dimension === OLD_DIMENSION) {
          const currentDimension = await detectEmbeddingDimension(memory.id);
          
          if (currentDimension === OLD_DIMENSION) {
            try {
              // Get current embedding
              const result = await pgClient.query(
                'SELECT embedding FROM memories WHERE id = $1',
                [memory.id]
              );
              
              if (result.rows.length > 0 && result.rows[0].embedding) {
                // Convert 384D to 1536D
                const convertedEmbedding = convert384To1536(result.rows[0].embedding);
                
                if (convertedEmbedding.length === TARGET_DIMENSION) {
                  const success = await updateMemoryEmbedding(memory.id, convertedEmbedding);
                  if (success) {
                    convertFixed++;
                    succeeded++;
                    console.log(`Converted 384D to 1536D for memory ${memory.id}`);
                  } else {
                    failed++;
                  }
                } else {
                  console.error(`Conversion failed for memory ${memory.id} - got ${convertedEmbedding.length}D vector`);
                  failed++;
                }
              }
            } catch (error) {
              console.error(`Error converting memory ${memory.id}: ${error.message}`);
              failed++;
            }
          } else {
            console.log(`Memory ${memory.id} dimension changed from ${memory.dimension} to ${currentDimension}`);
            failed++;
          }
        } else {
          console.log(`Skipping memory ${memory.id} - failed to fix (dimension: ${memory.dimension})`);
          failed++;
        }
        
        // Log progress periodically
        if (processed % 10 === 0 || processed === mismatchedMemories.length) {
          console.log(`Progress: ${processed}/${mismatchedMemories.length} (${succeeded} succeeded, ${failed} failed)`);
          console.log(`  - Regenerated: ${regeneFixed}`);
          console.log(`  - Converted: ${convertFixed}`);
          console.log(`  - No text: ${noText}`);
        }
      }
    }
    
    console.log('===== DIMENSION MISMATCH FIX SUMMARY =====');
    console.log(`Total processed: ${processed}/${mismatchedMemories.length}`);
    console.log(`Successfully fixed: ${succeeded}`);
    console.log(`  - Fixed by regeneration: ${regeneFixed}`);
    console.log(`  - Fixed by conversion: ${convertFixed}`);
    console.log(`Failed to fix: ${failed}`);
    console.log(`No text available: ${noText}`);
    console.log('=========================================');
    
  } catch (error) {
    console.error(`Error fixing dimension mismatches: ${error.message}`);
    console.error(error.stack);
  } finally {
    await pgClient.end();
  }
}

// Run the script
fixDimensionMismatches().catch(console.error); 