// Treasury Agent Register Handler
// Contains logic for handling wallet registration

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
  Content,
} from "@elizaos/core";
import {
  BaseContent,
  AgentMessage,
  ContentStatus,
} from "../../shared/types/base.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { PublicKey } from "@solana/web3.js";
import { getUserIdFromMessage, findUserIdByWalletAddress, normalizeUserId, getValidatedUserIdFromMessage } from "../../shared/utils/userUtils.ts";
import { validateSolanaAddress, createRegistrationResponse, parseRegisterCommand } from "./treasuryUtils.ts";
import { ANONYMOUS_USER_ID } from "../../shared/fixes/system-user.ts";
import { PendingWalletRegistration } from "../../shared/types/treasury.ts";
import { v4 } from "uuid";
import { IAgentRuntime } from "@elizaos/core";

// Extend AgentMessage type to include potential properties we might encounter
interface ExtendedAgentMessage extends AgentMessage {
  userId?: UUID;
}

// Helper function to detect confirmation intent in natural language
function detectConfirmationIntent(text: string): boolean {
  text = text.toLowerCase().trim();
  
  // Direct confirmation patterns
  if (text === "confirm" || text === "yes" || text === "ok") return true;
  
  // Natural language confirmation patterns
  const confirmPatterns = [
    /^(?:yes|yeah|yep|yup|sure|okay|ok|alright|fine|confirm|proceed|go ahead|do it|let'?s do it|i confirm|please confirm|confirmed)/i,
    /(?:yes|confirm|proceed|go ahead).+(?:confirm|proceed|do it|register|change|update)/i,
    /(?:i|please|yes).+(?:confirm|approve|accept|agree|want|would like)/i
  ];
  
  return confirmPatterns.some(pattern => pattern.test(text));
}

// Helper function to detect cancellation intent in natural language
function detectCancellationIntent(text: string): boolean {
  text = text.toLowerCase().trim();
  
  // Direct cancellation patterns
  if (text === "cancel" || text === "no") return true;
  
  // Natural language cancellation patterns
  const cancelPatterns = [
    /^(?:no|nah|nope|cancel|stop|abort|nevermind|never mind|don'?t|do not)/i,
    /(?:no|cancel|stop|abort).+(?:cancel|stop|abort|registration|process)/i,
    /(?:i|please|no).+(?:cancel|stop|abort|don'?t want|would not|wouldn'?t)/i
  ];
  
  return cancelPatterns.some(pattern => pattern.test(text));
}

// Helper function to extract wallet address from multiline text
function extractWalletFromMultiline(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const parsedCommand = parseRegisterCommand({ content: { text: line } } as AgentMessage);
    if (parsedCommand.walletAddress) {
      return parsedCommand.walletAddress;
    }
  }
  return null;
}

// Define WalletRegistrationMemory type at the top of the file
type WalletRegistrationMemory = {
    id: string;
    content: {
        type: string;
        userId: string;
        walletAddress: string;
        status: string;
        updatedAt?: number;
    };
    roomId: string;
};

// Add a diagnostic log function at the top of the file
function logDiagnostic(message: string, data: any): void {
  elizaLogger.info(`WALLET REGISTRATION DIAGNOSTIC: ${message}`, {
    ...data,
    diagnostic: true,
    component: "registerHandler",
    _treasuryOperation: true
  });
}

/**
 * Get user's active wallets with optimized memory querying
 */
export async function getUserWallets(
  agent: IAgentRuntime,
  userId: UUID
): Promise<{ walletAddress: string; status: string }[]> {
  elizaLogger.info("Processing wallet registration request", {
    operation: "getUserWallets",
    userId: userId.toString(),
    roomId: ROOM_IDS.DAO,
    function: "getUserWallets"
  });

  try {
    // DIAGNOSTIC: Add retry counters and results tracker for debugging
    let attemptCount = 0;
    const queryResults = [];

    // SIMPLIFIED QUERY 1: Try with minimal parameters - most essential query first
    attemptCount++;
    const simpleQuery = {
      roomId: ROOM_IDS.DAO,
      filter: {
        "content.type": "wallet_registration",
        "content.userId": userId,
        "content.status": { $in: ["active", "pending"] }
      },
      count: 100,
      sort: { "content.updatedAt": -1 }
    };

    // Log query parameters for debugging
    elizaLogger.info("ATTEMPT 1: Querying for wallet registrations with simple query", {
      operation: "getUserWallets",
      userId: userId.toString(),
      roomId: ROOM_IDS.DAO,
      filter: JSON.stringify(simpleQuery.filter),
      attempt: attemptCount
    });

    let existingWallets = [];
    try {
      existingWallets = await agent.messageManager.getMemories(simpleQuery);
      queryResults.push({ attempt: 1, success: true, count: existingWallets?.length || 0 });
      
      elizaLogger.info("Simple query results", {
        operation: "getUserWallets",
        walletCount: existingWallets?.length || 0,
        attempt: 1
      });
    } catch (queryError) {
      queryResults.push({ attempt: 1, success: false, error: queryError instanceof Error ? queryError.message : String(queryError) });
      elizaLogger.warn("Failed simple query attempt", {
        operation: "getUserWallets",
        error: queryError instanceof Error ? queryError.message : String(queryError),
        attempt: 1
      });
    }

    // QUERY 2: If no wallets found, try with all the Treasury operation markers
    if (!existingWallets || existingWallets.length === 0) {
      attemptCount++;
      const treasuryQuery = {
        roomId: ROOM_IDS.DAO,
        _treasuryOperation: true,
        filter: {
          "content.type": "wallet_registration",
          "content.userId": userId,
          "content.status": { $in: ["active", "pending"] },
          _treasuryOperation: true
        },
        metadata: {
          _treasuryOperation: true
        },
        count: 100,
        sort: { "content.updatedAt": -1 }
      };

      elizaLogger.info("ATTEMPT 2: Querying with Treasury operation markers", {
        operation: "getUserWallets",
        userId: userId.toString(),
        roomId: ROOM_IDS.DAO,
        attempt: attemptCount
      });

      try {
        existingWallets = await agent.messageManager.getMemories(treasuryQuery);
        queryResults.push({ attempt: 2, success: true, count: existingWallets?.length || 0 });
        
        elizaLogger.info("Treasury query results", {
          operation: "getUserWallets",
          walletCount: existingWallets?.length || 0,
          attempt: 2
        });
      } catch (queryError) {
        queryResults.push({ attempt: 2, success: false, error: queryError instanceof Error ? queryError.message : String(queryError) });
        elizaLogger.warn("Failed Treasury query attempt", {
          operation: "getUserWallets",
          error: queryError instanceof Error ? queryError.message : String(queryError),
          attempt: 2
        });
      }
    }

    // QUERY 3: If still no wallets, try legacy format as final fallback
    if (!existingWallets || existingWallets.length === 0) {
      attemptCount++;
      const legacyQuery = {
        roomId: ROOM_IDS.DAO,
        filter: {
          "content.type": "wallet_registration",
          userId: userId, // Legacy format - userId at top level
          "content.status": { $in: ["active", "pending"] }
        },
        count: 100,
        sort: { "content.updatedAt": -1 }
      };

      elizaLogger.info("ATTEMPT 3: Querying with legacy format", {
        operation: "getUserWallets", 
        userId: userId.toString(),
        roomId: ROOM_IDS.DAO,
        attempt: attemptCount
      });

      try {
        existingWallets = await agent.messageManager.getMemories(legacyQuery);
        queryResults.push({ attempt: 3, success: true, count: existingWallets?.length || 0 });
        
        elizaLogger.info("Legacy query results", {
          operation: "getUserWallets",
          walletCount: existingWallets?.length || 0,
          attempt: 3
        });
      } catch (queryError) {
        queryResults.push({ attempt: 3, success: false, error: queryError instanceof Error ? queryError.message : String(queryError) });
        elizaLogger.warn("Failed legacy query attempt", {
          operation: "getUserWallets",
          error: queryError instanceof Error ? queryError.message : String(queryError),
          attempt: 3
        });
      }
    }

    // QUERY 4: Last resort - try direct database access if available
    if (!existingWallets || existingWallets.length === 0) {
      attemptCount++;
      elizaLogger.info("ATTEMPT 4: Trying raw database query as last resort", {
        operation: "getUserWallets",
        userId: userId.toString(),
        attempt: attemptCount
      });

      try {
        // Use a very simplified query through messageManager as last resort
        const rawQuery = {
          roomId: ROOM_IDS.DAO,
          filter: {
            "content.type": "wallet_registration",
            "content.userId": userId.toString()
          },
          count: 100
        };
        
        const dbResults = await agent.messageManager.getMemories(rawQuery);

        if (dbResults && dbResults.length > 0) {
          existingWallets = dbResults;
          queryResults.push({ attempt: 4, success: true, count: existingWallets?.length || 0 });
          
          elizaLogger.info("Raw query results", {
            operation: "getUserWallets",
            walletCount: existingWallets?.length || 0,
            attempt: 4
          });
        } else {
          queryResults.push({ attempt: 4, success: true, count: 0 });
        }
      } catch (dbError) {
        queryResults.push({ attempt: 4, success: false, error: dbError instanceof Error ? dbError.message : String(dbError) });
        elizaLogger.warn("Failed raw query attempt", {
          operation: "getUserWallets",
          error: dbError instanceof Error ? dbError.message : String(dbError),
          attempt: 4
        });
      }
    }

    // Process results - get unique wallet addresses
    const walletAddresses = new Set<string>();
    const walletStatuses = new Map<string, string>();
    
    if (existingWallets && existingWallets.length > 0) {
      for (const wallet of existingWallets) {
        // Handle potential structure differences
        const address = wallet.content?.walletAddress || wallet.walletAddress;
        const status = wallet.content?.status || wallet.status;
        
        if (address && typeof address === 'string') {
          walletAddresses.add(address);
          walletStatuses.set(address, typeof status === 'string' ? status : 'unknown');
        }
      }
    }

    // Convert to array of objects with address and status
    const activeWallets = Array.from(walletAddresses).map(address => ({
      walletAddress: address,
      status: walletStatuses.get(address) || "unknown"
    }));

    // Log comprehensive summary
    elizaLogger.info("Wallet registration query results", {
      operation: "getUserWallets",
      userId: userId.toString(),
      totalActive: activeWallets.length,
      roomId: ROOM_IDS.DAO,
      queryAttempts: attemptCount,
      queryResults: queryResults
    });

    return activeWallets;
  } catch (error) {
    // Enhanced error logging with full details
    elizaLogger.error("Error getting user wallets", {
      operation: "getUserWallets",
      userId: userId.toString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomId: ROOM_IDS.DAO
    });
    
    // Return empty array as fallback
    return [];
  }
}

/**
 * Get pending registration with optimized querying and cleanup
 */
export async function getPendingRegistration(
  memoryManager: any,
  userId: UUID
): Promise<PendingWalletRegistration | null> {
  try {
    // First cleanup old cancelled registrations
    await cleanupOldCancelledRegistrations(memoryManager, userId);

    // Log the pending registration query
    elizaLogger.info("Checking for pending wallet registration", {
      operation: "getPendingRegistration",
      userId: userId.toString(),
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true
    });

    // ATTEMPT 1: Try with explicit Treasury markers first
    let pendingRegistrations = [];
    let errorEncountered = false;
    
    try {
      // Only get the most recent pending registration with Treasury operation markers
      pendingRegistrations = await memoryManager.getMemories({
        roomId: ROOM_IDS.DAO,
        _treasuryOperation: true, // Explicitly mark as Treasury operation
        filter: {
          "content.type": "pending_wallet_registration",
          "content.userId": userId,
          "content.status": "pending",
          _treasuryOperation: true // Also mark in filter
        },
        count: 1,
        sort: { "content.updatedAt": -1 },
        metadata: {
          _treasuryOperation: true, // Mark in metadata too
          source: "registerHandler",
          agentType: "TREASURY"
        }
      });
      
      elizaLogger.debug("Pending registration query with Treasury markers", {
        operation: "getPendingRegistration",
        found: pendingRegistrations.length > 0,
        count: pendingRegistrations.length,
        userId: userId.toString()
      });
    } catch (queryError) {
      errorEncountered = true;
      elizaLogger.warn("Error querying pending registrations with Treasury markers", {
        operation: "getPendingRegistration",
        error: queryError instanceof Error ? queryError.message : String(queryError),
        userId: userId.toString()
      });
    }
    
    // ATTEMPT 2: If first attempt failed or returned no results, try with minimal query
    if (pendingRegistrations.length === 0 || errorEncountered) {
      errorEncountered = false;
      try {
        elizaLogger.info("Trying simplified query for pending registrations", {
          operation: "getPendingRegistration",
          userId: userId.toString()
        });
        
        pendingRegistrations = await memoryManager.getMemories({
          roomId: ROOM_IDS.DAO,
          filter: {
            "content.type": "pending_wallet_registration",
            "content.userId": userId,
            "content.status": "pending"
          },
          count: 1,
          sort: { "content.updatedAt": -1 }
        });
        
        elizaLogger.debug("Pending registration query with simplified parameters", {
          operation: "getPendingRegistration",
          found: pendingRegistrations.length > 0,
          count: pendingRegistrations.length,
          userId: userId.toString()
        });
      } catch (simpleQueryError) {
        errorEncountered = true;
        elizaLogger.warn("Error in simplified query for pending registrations", {
          operation: "getPendingRegistration",
          error: simpleQueryError instanceof Error ? simpleQueryError.message : String(simpleQueryError),
          userId: userId.toString()
        });
      }
    }

    // If no results after all attempts, return null
    if (pendingRegistrations.length === 0) {
      elizaLogger.info("No pending wallet registration found", {
        operation: "getPendingRegistration",
        userId: userId.toString()
      });
      return null;
    }

    // Extract and validate the registration
    const registration = pendingRegistrations[0].content;
    
    // Validate registration structure
    if (!isPendingRegistration(registration)) {
      elizaLogger.warn("Invalid pending registration structure", { 
        userId: userId.toString(),
        contentKeys: Object.keys(registration || {}),
        isArray: Array.isArray(registration?.existingWallets)
      });
      return null;
    }

    // Log the found registration
    elizaLogger.info("Found pending wallet registration", {
      operation: "getPendingRegistration",
      userId: userId.toString(),
      walletAddress: registration.newWalletAddress,
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true
    });

    return registration;
  } catch (error) {
    // Enhanced error logging
    elizaLogger.error("Error in getPendingRegistration", {
      operation: "getPendingRegistration",
      userId: userId.toString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return null;
  }
}

/**
 * Cleanup old cancelled registrations to prevent memory buildup
 */
async function cleanupOldCancelledRegistrations(
  memoryManager: any,
  userId: UUID
): Promise<void> {
  try {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();

    elizaLogger.debug("Looking for old cancelled wallet registrations to clean up", {
      operation: "cleanupOldCancelledRegistrations",
      userId: userId.toString(),
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true
    });

    // Try multiple query approaches to find cancelled registrations
    let oldCancelled = [];
    let querySuccess = false;
    
    // ATTEMPT 1: Standard query with Treasury markers
    try {
      // Find old cancelled registrations with Treasury operation markers
      oldCancelled = await memoryManager.getMemories({
        roomId: ROOM_IDS.DAO,
        _treasuryOperation: true, // Mark as Treasury operation at top level
        filter: {
          "content.type": "pending_wallet_registration",
          "content.userId": userId,
          "content.status": "cancelled",
          "content.updatedAt": { $lt: now - ONE_DAY }, // Older than 1 day
          _treasuryOperation: true // Also mark in filter
        },
        count: 50,
        metadata: {
          _treasuryOperation: true, // Mark in metadata too
          source: "registerHandler",
          agentType: "TREASURY"
        }
      });
      
      querySuccess = true;
      elizaLogger.debug("Retrieved cancelled registrations with Treasury markers", {
        operation: "cleanupOldCancelledRegistrations",
        count: oldCancelled.length,
        userId: userId.toString()
      });
    } catch (queryError) {
      // Log error and proceed to try simpler query
      elizaLogger.warn("Error retrieving cancelled registrations with Treasury markers", {
        operation: "cleanupOldCancelledRegistrations",
        error: queryError instanceof Error ? queryError.message : String(queryError),
        userId: userId.toString()
      });
    }
    
    // ATTEMPT 2: If first query failed or returned no results, try simpler query
    if (!querySuccess || oldCancelled.length === 0) {
      try {
        // Try with simpler query without Treasury markers
        oldCancelled = await memoryManager.getMemories({
          roomId: ROOM_IDS.DAO,
          filter: {
            "content.type": "pending_wallet_registration",
            "content.userId": userId,
            "content.status": "cancelled",
            "content.updatedAt": { $lt: now - ONE_DAY } // Older than 1 day
          },
          count: 50
        });
        
        elizaLogger.debug("Retrieved cancelled registrations with simple query", {
          operation: "cleanupOldCancelledRegistrations",
          count: oldCancelled.length,
          userId: userId.toString()
        });
      } catch (simpleQueryError) {
        elizaLogger.warn("Error retrieving cancelled registrations with simple query", {
          operation: "cleanupOldCancelledRegistrations",
          error: simpleQueryError instanceof Error ? simpleQueryError.message : String(simpleQueryError),
          userId: userId.toString()
        });
      }
    }

    // Delete old cancelled registrations
    let deleteSuccessCount = 0;
    let deleteFailCount = 0;
    
    for (const reg of oldCancelled) {
      try {
        await memoryManager.removeMemory(reg.id);
        deleteSuccessCount++;
      } catch (removeError) {
        deleteFailCount++;
        elizaLogger.warn("Failed to remove cancelled registration", {
          operation: "cleanupOldCancelledRegistrations",
          memoryId: reg.id,
          error: removeError instanceof Error ? removeError.message : String(removeError),
          roomId: ROOM_IDS.DAO,
          _treasuryOperation: true
        });
        // Continue with other deletions even if one fails
        continue;
      }
    }

    if (oldCancelled.length > 0) {
      elizaLogger.info("Cleaned up old cancelled registrations", {
        operation: "cleanupOldCancelledRegistrations",
        userId: userId.toString(),
        count: oldCancelled.length,
        roomId: ROOM_IDS.DAO,
        deleteSuccessCount,
        deleteFailCount,
        _treasuryOperation: true
      });
    }
  } catch (error) {
    // Log error but don't throw - cleanup failure shouldn't block registration
    elizaLogger.error("Error cleaning up old cancelled registrations", {
      operation: "cleanupOldCancelledRegistrations",
      userId: userId.toString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true
    });
  }
}

/**
 * Type guard for pending registration
 */
function isPendingRegistration(content: any): content is PendingWalletRegistration {
  return (
    content &&
    typeof content.userId === "string" &&
    typeof content.newWalletAddress === "string" &&
    Array.isArray(content.existingWallets) &&
    typeof content.status === "string" &&
    typeof content.expiresAt === "number"
  );
}

/**
 * Create a pending registration
 */
async function createPendingRegistration(
  memoryManager: any,
  agent: any,
  userId: UUID,
  newWalletAddress: string,
  existingWallets: Array<{ walletAddress: string; status: string }>
): Promise<void> {
  try {
    // Validate inputs
    if (!userId) {
      throw new Error("userId is required for pending registration");
    }

    // Extract wallet address from either direct parameter or metadata
    const walletToRegister = newWalletAddress || 
      (typeof agent.lastMessage?.content?.metadata?.walletAddress === 'string' 
        ? agent.lastMessage.content.metadata.walletAddress 
        : undefined);

    if (!walletToRegister) {
      throw new Error("No wallet address provided for registration");
    }

    // Validate Solana address format
    try {
      new PublicKey(walletToRegister);
    } catch (error) {
      logDiagnostic("Invalid Solana wallet address format", {
        userId: userId.toString(), 
        walletAddress: walletToRegister,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Invalid Solana wallet address format: ${error.message}`);
    }

    logDiagnostic("Creating pending wallet registration", {
      userId: userId.toString(),
      walletAddress: walletToRegister,
      existingWallets: existingWallets?.length || 0,
      roomId: ROOM_IDS.DAO,
      operation: "createPendingRegistration"
    });

    const now = Date.now();
    const id = stringToUuid(v4());
    const pendingRegistration = {
      id,
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true, // Explicit Treasury marker at top level
      content: {
        type: "pending_wallet_registration",
        userId: userId,
        newWalletAddress: walletToRegister,
        existingWallets: existingWallets || [],
        expiresAt: now + (30 * 60 * 1000), // 30 minute expiration
        createdAt: now,
        updatedAt: now,
        status: "pending" as ContentStatus,
        text: `Pending wallet registration for user ${userId} - new wallet: ${walletToRegister}`,
        _treasuryOperation: true // Explicit Treasury marker in content
      },
      metadata: {
        _treasuryOperation: true, // Explicit Treasury marker in metadata
        source: "registerHandler",
        agentType: "TREASURY"
      }
    };

    // Try to create the pending registration with enhanced error handling
    try {
      await memoryManager.createMemory(pendingRegistration);
      
      logDiagnostic("Successfully created pending registration", {
        userId: userId.toString(),
        walletAddress: walletToRegister,
        memoryId: id,
        roomId: ROOM_IDS.DAO
      });
    } catch (memoryError) {
      // Log the error but throw it again to be handled by caller
      logDiagnostic("Failed to create pending registration", {
        userId: userId.toString(),
        walletAddress: walletToRegister,
        error: memoryError instanceof Error ? memoryError.message : String(memoryError)
      });
      throw memoryError;
    }
  } catch (error) {
    // Enhanced error reporting
    elizaLogger.error("Error creating pending wallet registration", {
      userId: userId?.toString() || "unknown",
      walletAddress: newWalletAddress || "unknown",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomId: ROOM_IDS.DAO,
      _treasuryOperation: true
    });
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Cancel all pending registrations for a user
 */
async function cancelAllPendingRegistrations(
  memoryManager: any,
  agent: any,
  userId: UUID,
  reason: string
): Promise<void> {
  const pendingRegistrations = await memoryManager.getMemories({
    roomId: ROOM_IDS.DAO, // Already correct, but being explicit
    filter: {
      "content.type": "pending_wallet_registration",
      "content.userId": userId,
      "content.status": "pending"
    },
    count: 100 // Get all pending to ensure we don't miss any
  });

  for (const registration of pendingRegistrations) {
    const pending = registration.content as PendingWalletRegistration;
    const now = Date.now();
    
    await memoryManager.createMemory({
      id: stringToUuid(`cancelled-registration-${userId}-${now}`),
      roomId: ROOM_IDS.DAO, // Already correct, but being explicit
      content: {
        type: "pending_wallet_registration",
        userId: pending.userId,
        newWalletAddress: pending.newWalletAddress,
        existingWallets: pending.existingWallets,
        expiresAt: pending.expiresAt,
        createdAt: pending.createdAt,
        updatedAt: now,
        status: "cancelled" as ContentStatus,
        agentId: agent.getAgentId(),
        text: `Cancelled wallet registration: ${reason}`,
        metadata: {
          originalId: registration.id,
          cancellationReason: reason,
          cancelledAt: now
        }
      }
    });
  }
}

/**
 * Handle a registration command
 */
export async function handleRegisterCommand(
    agent: any, 
    message: AgentMessage,
    callback?: (response: Content) => Promise<void>
): Promise<void> {
    let flowStage = "initializing";
    try {
        const userId = getUserIdFromMessage(message);
        
        logDiagnostic("Processing wallet registration request", { 
            userId: userId.toString(),
            messageType: message.content?.type,
            messageText: message.content?.text?.substring(0, 100),
            flowStage
        });

        // Extract wallet address from message
        flowStage = "extracting_wallet_address";
        const walletAddress = extractWalletFromMultiline(message.content?.text || '');
        if (!walletAddress) {
            logDiagnostic("No wallet address found in message", { 
                userId: userId.toString(),
                flowStage
            });
            
            if (callback) {
                await callback({
                    type: "response",
                    text: "I couldn't find a valid wallet address in your message. Please provide a Solana wallet address."
                });
            }
            return;
        }

        // Get existing wallets for user
        flowStage = "getting_existing_wallets";
        logDiagnostic("Retrieving existing wallets", {
            userId: userId.toString(),
            flowStage,
            walletToRegister: walletAddress
        });
        
        const existingWallets = await getUserWallets(agent, userId);
        
        logDiagnostic("Retrieved existing wallets", {
            userId: userId.toString(),
            walletCount: existingWallets.length,
            wallets: existingWallets.map(w => ({ address: w.walletAddress, status: w.status })),
            flowStage
        });

        // Check for pending registration
        flowStage = "checking_pending_registration";
        logDiagnostic("Checking for pending registration", {
            userId: userId.toString(),
            walletAddress,
            flowStage
        });
        
        const pendingReg = await getPendingRegistration(agent.getRuntime().messageManager, userId);
        
        // If pending registration exists, handle confirmation/cancellation flow
        if (pendingReg) {
            flowStage = "handling_pending_registration";
            logDiagnostic("Found pending registration", {
                userId: userId.toString(),
                pendingWallet: pendingReg.newWalletAddress,
                walletToRegister: walletAddress,
                existingWallets: pendingReg.existingWallets?.length,
                flowStage
            });

            const messageText = message.content?.text || '';
            const isConfirmation = detectConfirmationIntent(messageText);
            const isCancellation = detectCancellationIntent(messageText);
            
            // Log user intent detection
            logDiagnostic("Detected user intent", {
                userId: userId.toString(),
                messageText: messageText.substring(0, 50),
                isConfirmation,
                isCancellation,
                flowStage
            });

            if (isConfirmation) {
                // User confirmed - proceed with registration
                flowStage = "processing_confirmation";
                logDiagnostic("User confirmed pending registration", {
                    userId: userId.toString(),
                    newWallet: walletAddress,
                    flowStage
                });

                // Create the registration memory
                const registrationMemory = {
                    id: stringToUuid(v4()),
                    userId: userId, // Top-level userId for querying
                    roomId: ROOM_IDS.DAO,
                    _treasuryOperation: true, // Explicitly mark as Treasury operation
                    content: {
                        type: "wallet_registration",
                        walletAddress: walletAddress,
                        userId: userId, // Content-level userId for consistency
                        status: "executed",
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        text: `User ${userId} registered wallet ${walletAddress}`,
                        _treasuryOperation: true // Also mark at content level
                    },
                    metadata: {
                        _treasuryOperation: true, // Mark in metadata too
                        source: "registerHandler",
                        agentType: "TREASURY"
                    }
                };

                logDiagnostic("Creating wallet registration memory after confirmation", {
                    userId: userId.toString(),
                    walletAddress,
                    roomId: ROOM_IDS.DAO,
                    memoryId: registrationMemory.id,
                    flowStage
                });

                // Log explicit details for debugging
                elizaLogger.info("FINAL WALLET REGISTRATION: Creating with explicit Treasury markers", {
                    userId: userId.toString(),
                    walletAddress,
                    roomId: ROOM_IDS.DAO,
                    isTreasuryOperation: true,
                    operation: "handleRegisterCommand",
                    memoryId: registrationMemory.id,
                    flowStage
                });

                // Create with explicit Treasury operation context
                await agent.getRuntime().messageManager.createMemory({
                    ...registrationMemory,
                    metadata: {
                        _treasuryOperation: true,
                        agentType: "TREASURY"
                    }
                });

                // Mark old wallets as inactive
                flowStage = "deactivating_old_wallets";
                logDiagnostic("Marking old wallets as inactive", {
                    userId: userId.toString(),
                    oldWalletCount: existingWallets.length,
                    flowStage
                });
                
                for (const wallet of existingWallets) {
                    await markWalletInactive(agent, userId, wallet.walletAddress);
                }

                if (callback) {
                    await callback({
                        type: "response",
                        text: "Wallet successfully registered! Your previous wallets have been marked as inactive."
                    });
                }
            } else if (isCancellation) {
                // User cancelled
                flowStage = "processing_cancellation";
                logDiagnostic("User cancelled pending registration", {
                    userId: userId.toString(),
                    flowStage
                });
                
                await cancelAllPendingRegistrations(agent.getRuntime().messageManager, agent, userId, "User cancelled");
                
                if (callback) {
                    await callback({
                        type: "response",
                        text: "Wallet registration cancelled. Your existing wallet(s) will remain active."
                    });
                }
            } else {
                // Neither confirmation nor cancellation - remind user
                flowStage = "reminding_user";
                logDiagnostic("User needs to confirm or cancel", {
                    userId: userId.toString(),
                    flowStage
                });
                
                if (callback) {
                    await callback({
                        type: "response",
                        text: `You have a pending wallet registration. Please type 'confirm' to proceed with registering ${walletAddress} or 'cancel' to keep your existing wallet(s).`
                    });
                }
            }
            return;
        }

        // No pending registration - check if user has existing wallets
        if (existingWallets.length > 0) {
            // Create pending registration
            flowStage = "creating_pending_registration";
            logDiagnostic("User has existing wallets, creating pending registration", {
                userId: userId.toString(),
                existingWalletCount: existingWallets.length,
                newWalletAddress: walletAddress,
                flowStage
            });
            
            await createPendingRegistration(agent.getRuntime().messageManager, agent, userId, walletAddress, existingWallets);
            
            const walletList = existingWallets
                .map(w => w.walletAddress)
                .join(", ");
            
            if (callback) {
                await callback({
                    type: "response",
                    text: `You already have registered wallet(s): ${walletList}. Please type 'confirm' to replace them with ${walletAddress} or 'cancel' to keep your existing wallet(s).`
                });
            }
            return;
        }

        // No existing wallets - proceed with registration
        flowStage = "direct_registration";
        logDiagnostic("No existing wallets, proceeding with direct registration", {
            userId: userId.toString(),
            walletAddress,
            flowStage
        });
        
        const registrationMemory = {
            id: stringToUuid(v4()),
            userId: userId, // Top-level userId for querying
            roomId: ROOM_IDS.DAO,
            _treasuryOperation: true, // Explicitly mark as Treasury operation
            content: {
                type: "wallet_registration",
                walletAddress: walletAddress,
                userId: userId, // Content-level userId for consistency
                status: "executed",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                text: `User ${userId} registered wallet ${walletAddress}`,
                _treasuryOperation: true // Also mark at content level
            },
            metadata: {
                _treasuryOperation: true, // Mark in metadata too
                source: "registerHandler",
                agentType: "TREASURY"
            }
        };

        logDiagnostic("Creating new wallet registration", {
            userId: userId.toString(),
            walletAddress,
            roomId: ROOM_IDS.DAO,
            memoryId: registrationMemory.id,
            flowStage
        });

        // Log explicit details for debugging
        elizaLogger.info("FINAL WALLET REGISTRATION: Creating with explicit Treasury markers", {
            userId: userId.toString(),
            walletAddress,
            roomId: ROOM_IDS.DAO,
            isTreasuryOperation: true,
            operation: "handleRegisterCommand",
            memoryId: registrationMemory.id,
            flowStage
        });

        // Create with explicit Treasury operation context
        await agent.getRuntime().messageManager.createMemory({
            ...registrationMemory,
            metadata: {
                _treasuryOperation: true,
                agentType: "TREASURY"
            }
        });

        if (callback) {
            await callback({
                type: "response",
                text: "Wallet successfully registered!"
            });
        }
    } catch (error) {
        elizaLogger.error("Error in handleRegisterCommand", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            userId: getUserIdFromMessage(message).toString(),
            flowStage
        });
        
        if (callback) {
            await callback({
                type: "response",
                text: "Sorry, there was an error processing your wallet registration. Please try again."
            });
        }
    }
}

/**
 * Mark a wallet as inactive
 */
export async function markWalletInactive(agent: any, userId: UUID, walletAddress: string): Promise<boolean> {
  try {
    const wallets = await agent.getRuntime().messageManager.getMemories({
      roomId: ROOM_IDS.DAO, // Consistently use DAO room
      filter: {
        "content.type": "wallet_registration",
        "content.userId": userId,
        "content.walletAddress": walletAddress
      },
      count: 1
    });

    if (wallets.length === 0) {
      return false;
    }

    const wallet = wallets[0];
    
    // Create a new memory with inactive status
    await agent.getRuntime().messageManager.createMemory({
      id: stringToUuid(v4()),
      userId: userId,
      roomId: ROOM_IDS.DAO, // Ensure we store in the same room
      content: {
        type: "wallet_registration", // Explicitly set the type for Treasury detection
        walletAddress: walletAddress,
        userId: userId,
        status: "cancelled" as ContentStatus,
        text: `Wallet registration cancelled: ${walletAddress}`,
        createdAt: wallet.content.createdAt,
        updatedAt: Date.now(),
        metadata: {
          ...wallet.content.metadata,
          deactivatedAt: Date.now(),
          reason: "User requested deactivation"
        }
      }
    });

    return true;
  } catch (error) {
    elizaLogger.error("Error marking wallet inactive:", error);
    return false;
  }
}

function truncateAddress(address: string | undefined | null): string {
  if (!address) {
    elizaLogger.warn("Attempted to truncate undefined/null address");
    return "(no address)";
  }
  const maxLength = 10;
  if (address.length > maxLength) {
    return address.substring(0, maxLength) + "...";
  }
  return address;
} 