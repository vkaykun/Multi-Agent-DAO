// run-upgrade.js
// Wrapper script to run the embedding dimension upgrade with proper error handling
// This script ensures environment variables are properly loaded and logs all output

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Configuration
const LOG_FILE = `vector-upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
const UPGRADE_SCRIPT = 'upgrade-embeddings.js';

// Ensure the upgrade script exists
if (!fs.existsSync(UPGRADE_SCRIPT)) {
  console.error(`Error: ${UPGRADE_SCRIPT} does not exist in the current directory.`);
  process.exit(1);
}

// Start logger
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  
  // Log to console
  console.log(formattedMessage);
  
  // Log to file
  logStream.write(formattedMessage + '\n');
}

log(`Starting vector dimension upgrade process`);
log(`Logs will be written to: ${path.resolve(LOG_FILE)}`);

// Check for required environment variables
const requiredEnvVars = ['DATABASE_URL', 'OPENAI_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  log(`⚠️ Warning: Missing required environment variables: ${missingVars.join(', ')}`);
  log(`Please ensure these are set in your .env file or environment`);
  
  // Continue anyway - the main script will handle these errors
}

// Run the upgrade script
log(`Executing upgrade script: ${UPGRADE_SCRIPT}`);

const upgradeProcess = spawn('node', [UPGRADE_SCRIPT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env
});

// Pipe stdout to both console and log file
upgradeProcess.stdout.on('data', (data) => {
  const output = data.toString().trim();
  if (output) {
    output.split('\n').forEach(line => log(`[stdout] ${line}`));
  }
});

// Pipe stderr to both console and log file
upgradeProcess.stderr.on('data', (data) => {
  const output = data.toString().trim();
  if (output) {
    output.split('\n').forEach(line => log(`[stderr] ${line}`));
  }
});

// Handle process completion
upgradeProcess.on('close', (code) => {
  if (code === 0) {
    log(`✅ Upgrade completed successfully`);
  } else {
    log(`❌ Upgrade failed with exit code ${code}`);
  }
  
  log(`Vector dimension upgrade process completed`);
  logStream.end();
});

// Handle unexpected errors
upgradeProcess.on('error', (err) => {
  log(`❌ Failed to start upgrade process: ${err.message}`);
  logStream.end();
  process.exit(1);
}); 