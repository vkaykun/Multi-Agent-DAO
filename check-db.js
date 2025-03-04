// check-db.js
// Script to check memory embeddings in the database

import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Database connection details from .env
const dbConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
};

console.log('Database connection config:', {
  connectionString: process.env.DATABASE_URL ? 'Found connection string' : 'Missing connection string',
  ssl: !!dbConfig.ssl,
});

// Initialize PostgreSQL client
const client = new Client(dbConfig);

async function checkEmbeddings() {
  try {
    console.log('Connecting to database...');
    await client.connect();
    
    console.log('Testing connection...');
    const testResult = await client.query('SELECT NOW()');
    console.log('Database connection successful:', testResult.rows[0].now);
    
    // Check table existence
    try {
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      
      console.log('Tables in database:');
      tablesResult.rows.forEach(row => console.log(`- ${row.table_name}`));
      
      // Check if memories table exists
      const hasMemoriesTable = tablesResult.rows.some(row => row.table_name === 'memories');
      if (!hasMemoriesTable) {
        console.log('No memories table found in the database');
        return;
      }
    } catch (err) {
      console.error('Error checking tables:', err.message);
    }
    
    // Check embedding counts
    try {
      const countResult = await client.query(`
        SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL
      `);
      
      console.log(`Found ${countResult.rows[0].count} memories with embeddings`);
      
      if (parseInt(countResult.rows[0].count) > 0) {
        // Check dimensions by approx length of cast
        const dimCheck = await client.query(`
          SELECT CASE 
            WHEN LENGTH(CAST(embedding AS text)) > 1000 THEN 1536
            ELSE 384
          END as approximate_dimension,
          COUNT(*) 
          FROM memories 
          WHERE embedding IS NOT NULL
          GROUP BY 1
        `);
        
        console.log('Embedding dimension distribution (approximate):');
        console.table(dimCheck.rows);
        
        // Sample a few embeddings
        const sampleResults = await client.query(`
          SELECT id, 
                 LENGTH(CAST(embedding AS text)) as vector_length,
                 substring(CAST(embedding AS text), 1, 50) as vector_sample
          FROM memories 
          WHERE embedding IS NOT NULL
          LIMIT 3
        `);
        
        console.log('Sample embeddings:');
        sampleResults.rows.forEach(row => {
          console.log(`- ID: ${row.id}, Vector length: ${row.vector_length}`);
          console.log(`  Sample: ${row.vector_sample}...`);
        });
      }
    } catch (err) {
      console.error('Error checking embeddings:', err.message);
    }
    
  } catch (error) {
    console.error('Database check error:', error.message);
  } finally {
    await client.end();
  }
}

checkEmbeddings().catch(console.error); 