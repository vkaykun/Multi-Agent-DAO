// clear-and-update-embeddings.js
// Script to clear outdated 384D embeddings and re-generate with 1536D vectors
// This addresses the issue with getCachedEmbeddings returning 0 results

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
const BATCH_SIZE = 50;
const OUTDATED_DIMENSION = 384; // The dimension we're replacing

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
 * Find memories with outdated embeddings (384D)
 */
async function findOutdatedEmbeddings() {
  console.log(`Finding embeddings with dimension ${OUTDATED_DIMENSION}...`);
  
  try {
    // First check if we can use array_length
    try {
      await pgClient.query('SELECT array_length(ARRAY[1,2,3], 1)');
      console.log('Using array_length function for dimension check');
      
      const result = await pgClient.query(
        `SELECT id, content FROM memories 
         WHERE embedding IS NOT NULL 
         AND array_length(embedding, 1) = $1
         ORDER BY "createdAt"`,
        [OUTDATED_DIMENSION]
      );
      
      console.log(`Found ${result.rows.length} memories with outdated ${OUTDATED_DIMENSION}D embeddings`);
      return result.rows;
    } catch (error) {
      console.log('array_length function not available, using alternative approach');
      
      // Alternative approach: Check the first few memories and manually verify dimensions
      const result = await pgClient.query(
        `SELECT id, content, embedding FROM memories 
         WHERE embedding IS NOT NULL 
         ORDER BY "createdAt" 
         LIMIT 100`
      );
      
      // Filter memories with outdated dimensions
      const outdatedMemories = result.rows.filter(row => {
        if (!Array.isArray(row.embedding)) return false;
        return row.embedding.length === OUTDATED_DIMENSION;
      });
      
      console.log(`Found ${outdatedMemories.length} memories with outdated ${OUTDATED_DIMENSION}D embeddings`);
      return outdatedMemories.map(row => ({ id: row.id, content: row.content }));
    }
  } catch (error) {
    console.error(`Error finding outdated embeddings: ${error.message}`);
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
 * Main function to clear outdated embeddings and update them
 */
async function clearAndUpdateEmbeddings() {
  try {
    console.log('Connecting to database...');
    await pgClient.connect();
    
    console.log('Checking database connection...');
    await pgClient.query('SELECT NOW()');
    
    // Find outdated embeddings
    const outdatedMemories = await findOutdatedEmbeddings();
    
    if (outdatedMemories.length === 0) {
      console.log('No outdated embeddings found. Exiting.');
      return;
    }
    
    console.log(`Processing ${outdatedMemories.length} memories with outdated embeddings...`);
    
    // Process in batches
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let cleared = 0;
    
    for (let i = 0; i < outdatedMemories.length; i += BATCH_SIZE) {
      const batch = outdatedMemories.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${i/BATCH_SIZE + 1}/${Math.ceil(outdatedMemories.length/BATCH_SIZE)}...`);
      
      // First clear the batch to ensure clean state
      const memoryIds = batch.map(memory => memory.id);
      cleared += await clearEmbeddings(memoryIds);
      
      // Then regenerate each embedding
      for (const memory of batch) {
        processed++;
        const text = extractTextForEmbedding(memory.content);
        
        if (!text || text.length < 3) {
          console.log(`Skipping memory ${memory.id} - insufficient text`);
          continue;
        }
        
        const embedding = await generateEmbedding(text);
        
        if (embedding && embedding.length === TARGET_DIMENSION) {
          const success = await updateMemoryEmbedding(memory.id, embedding);
          if (success) {
            succeeded++;
          } else {
            failed++;
          }
        } else {
          console.log(`Skipping memory ${memory.id} - failed to generate valid embedding`);
          failed++;
        }
        
        // Log progress periodically
        if (processed % 10 === 0) {
          console.log(`Progress: ${processed}/${outdatedMemories.length} (${succeeded} succeeded, ${failed} failed)`);
        }
      }
    }
    
    console.log('===== EMBEDDING UPDATE SUMMARY =====');
    console.log(`Total outdated embeddings: ${outdatedMemories.length}`);
    console.log(`Cleared embeddings: ${cleared}`);
    console.log(`Processed: ${processed}`);
    console.log(`Successfully updated: ${succeeded}`);
    console.log(`Failed to update: ${failed}`);
    console.log('===================================');
    
  } catch (error) {
    console.error(`Error in clearAndUpdateEmbeddings: ${error.message}`);
    console.error(error.stack);
  } finally {
    await pgClient.end();
  }
}

// Run the script
clearAndUpdateEmbeddings().catch(console.error); 