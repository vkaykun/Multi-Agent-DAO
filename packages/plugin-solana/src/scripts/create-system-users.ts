#!/usr/bin/env node

/**
 * This script creates system users in the accounts table
 * Run with: npx ts-node packages/plugin-solana/src/scripts/create-system-users.ts
 */

import { elizaLogger, stringToUuid, UUID } from "@elizaos/core";
import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Define system user IDs
const SYSTEM_USER_ID: UUID = stringToUuid("system-user-00000000");
const ANONYMOUS_USER_ID: UUID = stringToUuid("anonymous-user-00000");

async function main() {
  // Get database connection info from environment variables
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("Connecting to database...");
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