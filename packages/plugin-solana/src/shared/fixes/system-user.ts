import { elizaLogger, UUID, IAgentRuntime } from "@elizaos/core";
import pkg from "pg";
const { Pool } = pkg;

// Define system user IDs with hardcoded values that match the database
// This was modified to use the exact UUID that works in the database instead of generating dynamically
export const SYSTEM_USER_ID: UUID = "2124c694-3828-5d85-b6e6-bf1e6ade6efd" as UUID; // Generated from stringToUuid("system-user-00000000")
export const ANONYMOUS_USER_ID: UUID = "95dbe008-3908-0350-8936-72d41ec81542" as UUID; // This is the value that works in the database

/**
 * Ensures that system users exist in the database
 * @param runtime The agent runtime
 */
export async function ensureSystemUsers(runtime: IAgentRuntime): Promise<void> {
  const logger = elizaLogger.child({ module: "SystemUserFix" });
  logger.info("Ensuring system users exist in the database");

  try {
    // Get database connection info from environment variables
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      logger.error("DATABASE_URL environment variable is required");
      return;
    }

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
        logger.info("Creating accounts table...");
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
        logger.info("Creating system user...");
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
        logger.info("System user created successfully");
      } else {
        logger.debug("System user already exists");
      }

      // Check if anonymous user exists
      const anonymousUserCheck = await pool.query(
        "SELECT COUNT(*) as count FROM accounts WHERE id = $1",
        [ANONYMOUS_USER_ID]
      );
      
      if (parseInt(anonymousUserCheck.rows[0].count) === 0) {
        logger.info("Creating anonymous user...");
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
        logger.info("Anonymous user created successfully");
      } else {
        logger.debug("Anonymous user already exists");
      }

      logger.info("System users check completed");
    } catch (error) {
      logger.error("Error ensuring system users:", error);
    } finally {
      await pool.end();
    }
  } catch (error) {
    logger.error("Failed to ensure system users:", error);
  }
} 