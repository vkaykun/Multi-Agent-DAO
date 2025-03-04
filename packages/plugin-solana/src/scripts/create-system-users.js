#!/usr/bin/env node

/**
 * This script creates system users in the accounts table
 * Run with: node packages/plugin-solana/src/scripts/create-system-users.js
 */

import { v5 as uuidv5 } from 'uuid';
import pg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pg;

// Load environment variables
dotenv.config();

// Function to convert string to UUID consistently (like stringToUuid from @elizaos/core)
function stringToUuid(str) {
  // Use UUID v5 with a consistent namespace to generate the same UUID for the same string
  const NAMESPACE = '00000000-0000-0000-0000-000000000000';
  return uuidv5(str, NAMESPACE);
}

// Define system user IDs
const SYSTEM_USER_ID = stringToUuid("system-user-00000000");
const ANONYMOUS_USER_ID = stringToUuid("anonymous-user-00000");

async function main() {
  // Get database connection info from environment variables
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("Connecting to database...");
  console.log("System User ID:", SYSTEM_USER_ID);
  console.log("Anonymous User ID:", ANONYMOUS_USER_ID);
  
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: process.env.DATABASE_SSL === "true" ? 
      { rejectUnauthorized: false } : 
      false
  });

  try {
    // Check if accounts table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'accounts'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log("Creating accounts table...");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          username TEXT NOT NULL,
          email TEXT,
          "avatarUrl" TEXT,
          details JSONB
        );
      `);
    }

    // Check if system user exists
    const systemUserCheck = await pool.query(
      "SELECT COUNT(*) as count FROM accounts WHERE id = $1",
      [SYSTEM_USER_ID]
    );
    
    if (parseInt(systemUserCheck.rows[0].count) === 0) {
      console.log("Creating system user...");
      await pool.query(
        `INSERT INTO accounts (id, name, username, email, "avatarUrl", details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          SYSTEM_USER_ID,
          "System",
          "System User",
          "",
          "",
          JSON.stringify({ isSystem: true })
        ]
      );
      console.log("System user created successfully");
    } else {
      console.log("System user already exists");
    }

    // Check if anonymous user exists
    const anonymousUserCheck = await pool.query(
      "SELECT COUNT(*) as count FROM accounts WHERE id = $1",
      [ANONYMOUS_USER_ID]
    );
    
    if (parseInt(anonymousUserCheck.rows[0].count) === 0) {
      console.log("Creating anonymous user...");
      await pool.query(
        `INSERT INTO accounts (id, name, username, email, "avatarUrl", details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          ANONYMOUS_USER_ID,
          "Anonymous",
          "Anonymous User",
          "",
          "",
          JSON.stringify({ isSystem: true, isAnonymous: true })
        ]
      );
      console.log("Anonymous user created successfully");
    } else {
      console.log("Anonymous user already exists");
    }

    console.log("All system users created successfully");
  } catch (error) {
    console.error("Error creating system users:", error);
  } finally {
    await pool.end();
  }
}

main().catch(console.error); 