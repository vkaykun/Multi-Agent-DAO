// Script to run the vector dimension migration
import fs from 'fs';
import path from 'path';
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
  connectionString: dbConfig.connectionString ? 'Found connection string' : 'Missing connection string',
  ssl: !!dbConfig.ssl,
});

// Read the SQL migration script
const sqlScript = fs.readFileSync(
  path.resolve(process.cwd(), 'migrate-vector-dimensions.sql'),
  'utf8'
);

// Modified script without backup
const skipBackupScript = sqlScript
  // Skip backup table creation
  .replace(/-- Step 1:.+?memories;/s, '-- Skipping backup as requested')
  // Uncomment DROP TABLE line
  .replace(/-- DROP TABLE.+?;/, '');

console.log('Running vector dimension migration...');

// Initialize PostgreSQL client
const client = new Client(dbConfig);

async function runMigration() {
  try {
    console.log('Connecting to database...');
    await client.connect();
    
    console.log('Testing connection...');
    const testResult = await client.query('SELECT NOW()');
    console.log('Database connection successful:', testResult.rows[0].now);
    
    console.log('Executing migration script (this may take a while)...');
    
    // Execute script statements one by one
    const statements = skipBackupScript.split(/;\s*$/m).filter(stmt => stmt.trim());
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].trim();
      if (stmt) {
        try {
          console.log(`Executing statement ${i+1}/${statements.length}...`);
          const result = await client.query(stmt + ';');
          
          // Log any relevant results
          if (result.rows && result.rows.length > 0 && 
              (stmt.toLowerCase().includes('select') || stmt.toLowerCase().includes('raise'))) {
            console.log('Result:', result.rows);
          }
        } catch (err) {
          console.error(`Error executing statement ${i+1}:`, err.message);
          console.error('Statement:', stmt);
          // Continue with next statement
        }
      }
    }
    
    console.log('Migration completed!');
    
    // Final check of vector dimensions
    console.log('Verifying final vector dimensions...');
    const finalCheck = await client.query(`
      SELECT 
        array_length(embedding, 1) as dimension,
        COUNT(*) as count
      FROM memories
      WHERE embedding IS NOT NULL
      GROUP BY dimension
      ORDER BY dimension;
    `);
    
    console.log('Current vector dimensions in database:');
    console.table(finalCheck.rows);
    
  } catch (error) {
    console.error('Migration error:', error);
  } finally {
    await client.end();
  }
}

runMigration().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
}); 