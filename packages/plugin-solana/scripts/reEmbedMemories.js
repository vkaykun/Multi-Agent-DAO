// packages/plugin-solana/scripts/reEmbedMemories.js
// Script to re-embed existing memories in the database with 1536D vectors

import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { OpenAI } from 'openai';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env.vela') });

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize PostgreSQL client
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Batch size for processing
const BATCH_SIZE = 50;
// The embedding model to use
const EMBEDDING_MODEL = process.env.EMBEDDING_OPENAI_MODEL || 'text-embedding-ada-002';
// Target dimension
const TARGET_DIMENSION = 1536;

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
 * Get total count of memories
 * @returns {Promise<number>} - Total memories count
 */
async function getMemoriesCount() {
  const result = await pgClient.query('SELECT COUNT(*) FROM memories');
  return parseInt(result.rows[0].count);
}

/**
 * Get batch of memories to re-embed
 * @param {number} offset - Starting offset
 * @param {number} limit - Batch size
 * @returns {Promise<Array>} - Array of memories
 */
async function getMemoriesBatch(offset, limit) {
  const result = await pgClient.query(
    `SELECT id, content FROM memories 
     WHERE embedding IS NOT NULL 
     ORDER BY "createdAt" 
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

/**
 * Update memory with new embedding
 * @param {string} id - Memory ID
 * @param {number[]} embedding - New embedding vector
 * @returns {Promise<boolean>} - Success status
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
 * Extract text from memory content for embedding
 * @param {Object} content - Memory content
 * @returns {string} - Text for embedding
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
 * Main function to re-embed all memories
 */
async function reEmbedMemories() {
  try {
    console.log('Connecting to database...');
    await pgClient.connect();
    
    console.log('Checking database connection...');
    await pgClient.query('SELECT NOW()');
    
    const totalMemories = await getMemoriesCount();
    console.log(`Found ${totalMemories} memories in database`);
    
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    
    // Process in batches
    for (let offset = 0; offset < totalMemories; offset += BATCH_SIZE) {
      console.log(`Processing batch starting at offset ${offset}...`);
      const memories = await getMemoriesBatch(offset, BATCH_SIZE);
      
      for (const memory of memories) {
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
          console.log(`Progress: ${processed}/${totalMemories} (${succeeded} succeeded, ${failed} failed)`);
        }
      }
    }
    
    console.log(`Re-embedding complete! Processed ${processed} memories.`);
    console.log(`Results: ${succeeded} succeeded, ${failed} failed`);
  } catch (error) {
    console.error(`Error in re-embedding process: ${error.message}`);
    console.error(error.stack);
  } finally {
    await pgClient.end();
  }
}

// Run the script
reEmbedMemories().catch(console.error); 