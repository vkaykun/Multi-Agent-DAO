// Simple direct alteration script
import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function alterVectorDimension() {
  // Database connection details from .env
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    
    console.log('Testing connection...');
    const testResult = await client.query('SELECT NOW()');
    console.log('Database connection successful:', testResult.rows[0].now);

    // Check if vector extension is installed
    console.log('Checking pgvector extension...');
    const extResult = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    
    if (extResult.rows.length === 0) {
      console.error('pgvector extension is not installed!');
      return;
    }
    
    console.log('pgvector extension is installed:', extResult.rows[0].extname);
    
    // Check current dimensions
    console.log('Checking current vector dimensions...');
    const dimensionCheck = await client.query(`
      SELECT 
        CASE 
          WHEN LENGTH(CAST(embedding AS text)) > 1000 THEN 1536
          ELSE 384
        END as approximate_dimension,
        COUNT(*) 
      FROM memories 
      WHERE embedding IS NOT NULL
      GROUP BY 1
    `);
    
    if (dimensionCheck.rows.length > 0) {
      console.log('Current vector dimensions:');
      console.table(dimensionCheck.rows);
    } else {
      console.log('No vectors found in the database.');
    }
    
    // Execute the direct alteration
    console.log('Altering vector dimension to 1536...');
    await client.query(`
      ALTER TABLE memories
        ALTER COLUMN embedding TYPE vector(1536)
    `);
    
    console.log('Vector dimension successfully altered to 1536!');
    
    // Verify the change
    console.log('Verifying the change...');
    const verificationCheck = await client.query(`
      SELECT 
        CASE 
          WHEN LENGTH(CAST(embedding AS text)) > 1000 THEN 1536
          ELSE 384
        END as dimension,
        COUNT(*) 
      FROM memories 
      WHERE embedding IS NOT NULL
      GROUP BY 1
    `);
    
    if (verificationCheck.rows.length > 0) {
      console.log('Current vector dimensions after migration:');
      console.table(verificationCheck.rows);
    } else {
      console.log('No vectors found in the database after migration.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.hint) console.error('Hint:', error.hint);
    if (error.detail) console.error('Detail:', error.detail);
  } finally {
    await client.end();
  }
}

alterVectorDimension().catch(console.error); 