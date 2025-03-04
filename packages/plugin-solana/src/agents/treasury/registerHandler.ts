// Treasury Agent Register Handler
// Contains logic for handling wallet registration

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
  Content,
  IMemoryManager,
  IAgentRuntime
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
import axios from 'axios';
import { CONVERSATION_ROOM_ID } from "../../shared/utils/messageUtils.ts";

// Extend AgentMessage type to include potential properties we might encounter
interface ExtendedAgentMessage extends AgentMessage {
  userId?: UUID;
}

// Define WalletContent type for wallet registration
interface WalletContent extends Content {
  walletAddress: string;
  status: string; // Can be "pending", "active", or "inactive"
  type: string;
  userId: string;
  [key: string]: any;
}

// Define memory type with wallet content
interface WalletMemory extends Omit<Memory, 'content'> {
  metadata?: Record<string, any>;
  content: WalletContent;
}

// Type guard function to check if a memory is a wallet memory
function isWalletMemory(memory: Memory): memory is WalletMemory {
  return (
    memory.content &&
    typeof memory.content.walletAddress === 'string' &&
    typeof memory.content.status === 'string' &&
    typeof memory.content.type === 'string' &&
    typeof memory.content.userId === 'string'
  );
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
 * Get all registered wallets for a user
 * Enhanced with detailed logging for debugging retrieval issues
 */
export async function getUserWallets(
  runtime: IAgentRuntime,
  userId: UUID
): Promise<Array<{ walletAddress: string; status: string }>> {
  // Always normalize userId for consistent lookup
  const normalizedUserId = normalizeUserId(userId.toString()) || userId.toString();
  const rawDiscordId = extractRawDiscordId(userId.toString());
  
  elizaLogger.info("🔍 Getting wallets for user", {
    originalUserId: userId.toString(),
    normalizedUserId,
    rawDiscordId,
    operation: "getUserWallets"
  });

  try {
    // First, try to use our enhanced diagnostic query if available
    if ((runtime.messageManager as any)?.adapter?.executeWalletDiagnosticQuery) {
      try {
        elizaLogger.info("🔍 Using diagnostic query for wallet lookup", { 
          normalizedUserId,
          rawDiscordId
        });
        
        // Pass normalized ID to diagnostic query
        const diagnosticResults = await (runtime.messageManager as any).adapter.executeWalletDiagnosticQuery(normalizedUserId);
        
        // Map the diagnostic results to wallet objects
        if (diagnosticResults && diagnosticResults.length > 0) {
          elizaLogger.info(`✅ Found ${diagnosticResults.length} wallets via diagnostic query`, { 
            normalizedUserId,
            rawDiscordId
          });
          
          // Convert raw db results to wallet objects
          const wallets = diagnosticResults
            .filter((result: any) => result.content?.status === 'active')
            .map((result: any) => ({
              walletAddress: result.content?.walletAddress,
              status: result.content?.status
            }));
            
          elizaLogger.info(`📊 Returning ${wallets.length} active wallets via diagnostic query`, { 
            normalizedUserId,
            rawDiscordId,
            walletAddresses: wallets.map(w => w.walletAddress).join(', ')
          });
          
          return wallets;
        }
      } catch (err) {
        elizaLogger.warn("⚠️ Diagnostic query failed, falling back to normal query", {
          normalizedUserId,
          rawDiscordId,
          error: err instanceof Error ? err.message : String(err)
        });
        // Continue with standard query approach
      }
    }
    
    // Standard approach - array to collect results
    let walletMemories: WalletMemory[] = [];
    let methodUsed = "none";
    
    // 1. First attempt: Use queryMemoriesWithFilters helper (preferred)
    try {
      elizaLogger.info("🔍 Querying wallets with queryMemoriesWithFilters helper", { 
        normalizedUserId,
        rawDiscordId
      });
      
      walletMemories = await queryMemoriesWithFilters(
        runtime,
        CONVERSATION_ROOM_ID,
        {
          "content.type": "wallet_registration",
          "content.userId": normalizedUserId,
          "content.status": "active",
        },
        30  // Increased count to ensure we find all wallets
      ) as WalletMemory[];
      
      if (walletMemories.length > 0) {
        methodUsed = "queryMemoriesWithFilters";
        elizaLogger.info(`📊 Found ${walletMemories.length} wallets using queryMemoriesWithFilters helper`, { 
          normalizedUserId,
          rawDiscordId
        });
      } else {
        elizaLogger.info(`🔍 No wallets found with queryMemoriesWithFilters helper, trying alternatives`, { 
          normalizedUserId
        });
      }
    } catch (error) {
      elizaLogger.warn("⚠️ Error in queryMemoriesWithFilters helper", {
        normalizedUserId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    // 2. Second attempt: Try using getMemoriesWithFilters method directly
    if (walletMemories.length === 0 && typeof (runtime.messageManager as any).getMemoriesWithFilters === 'function') {
      try {
        elizaLogger.info("🔍 Trying direct getMemoriesWithFilters method", { normalizedUserId });
        
        walletMemories = await (runtime.messageManager as any).getMemoriesWithFilters({
          roomId: CONVERSATION_ROOM_ID,
          filter: {
            "content.type": "wallet_registration",
            "content.userId": normalizedUserId,
            "content.status": "active",
          },
          count: 30,
          sortBy: "updatedAt",
          sortDirection: "desc"
        }) as WalletMemory[];
        
        if (walletMemories.length > 0) {
          methodUsed = "getMemoriesWithFilters";
          elizaLogger.info(`📊 Found ${walletMemories.length} wallets using direct getMemoriesWithFilters`, { 
            normalizedUserId,
            memoryIds: walletMemories.map(w => w.id).join(', ')
          });
        }
      } catch (error) {
        elizaLogger.warn("⚠️ Error in direct getMemoriesWithFilters call", {
          normalizedUserId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    // 3. Last resort: direct getMemories with filtering in memory
    if (walletMemories.length === 0) {
      try {
        elizaLogger.info("🔍 Last resort: Using getMemories with in-memory filtering", { normalizedUserId });
        
        // Get all memories and filter in memory - less efficient but better than nothing
        const allMemories = await runtime.messageManager.getMemories({
          roomId: CONVERSATION_ROOM_ID,
          count: 200, // Higher count to ensure we catch all wallets
        });
        
        // Manual filtering to find wallet registrations for this user
        walletMemories = allMemories.filter(memory => 
          memory.content?.type === "wallet_registration" && 
          memory.content?.userId === normalizedUserId &&
          memory.content?.status === "active"
        ) as WalletMemory[];
        
        if (walletMemories.length > 0) {
          methodUsed = "getMemories+filter";
          elizaLogger.info(`📊 Found ${walletMemories.length} wallets using getMemories with in-memory filtering`, { 
            normalizedUserId,
            totalMemoriesScanned: allMemories.length
          });
        } else {
          elizaLogger.warn(`❌ No wallet registrations found with any method`, { 
            normalizedUserId,
            methodsAttempted: "diagnosticQuery, queryMemoriesWithFilters, getMemoriesWithFilters, getMemories+filter"
          });
        }
      } catch (error) {
        elizaLogger.error("❌ Final attempt failed - all wallet query methods failed", {
          normalizedUserId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    // Process and return wallet data
    if (walletMemories.length > 0) {
      elizaLogger.info(`🔍 Found ${walletMemories.length} wallet memories using ${methodUsed}, filtering for valid active wallets`, {
        normalizedUserId,
        memoryIds: walletMemories.length > 0 ? walletMemories.map(w => w.id).slice(0, 5).join(', ') + (walletMemories.length > 5 ? '...' : '') : 'none'
      });
      
      // Add detailed diagnostics for each memory
      walletMemories.forEach((memory, index) => {
        if (index < 10) { // Limit logging to first 10 memories
          elizaLogger.debug(`Memory ${index + 1}/${walletMemories.length} inspection:`, {
            id: memory.id,
            hasWalletAddress: !!memory.content?.walletAddress,
            walletAddressValue: memory.content?.walletAddress?.substring(0, 8) + '...',
            hasStatus: !!memory.content?.status,
            statusValue: memory.content?.status,
            contentType: memory.content?.type,
            isValid: !!(memory.content?.status === "active" && memory.content?.walletAddress),
            methodUsed,
            flowStage: 'diagnostics'
          });
        }
      });
      
      const wallets = walletMemories
        .filter(memory => {
          const isValid = memory.content?.status === "active" && !!memory.content?.walletAddress;
          if (!isValid && walletMemories.length <= 10) {
            elizaLogger.info(`Filtering out memory ${memory.id}:`, {
              reason: !memory.content?.status ? "Missing status" : 
                     memory.content.status !== "active" ? `Status not active: ${memory.content.status}` : 
                     !memory.content?.walletAddress ? "Missing walletAddress" : "Unknown reason",
              methodUsed,
              flowStage: 'filtering'
            });
          }
          return isValid;
        })
        .map(memory => ({
          walletAddress: memory.content?.walletAddress,
          status: memory.content?.status
        }));
      
      elizaLogger.info(`✅ Successfully found ${wallets.length} active wallets for user with ${methodUsed}`, { 
        normalizedUserId,
        walletAddresses: wallets.map(w => w.walletAddress).join(', ')
      });
      
      return wallets;
    }
    
    // No wallets found
    elizaLogger.info(`🔍 No active wallets found for user`, { normalizedUserId });
    return [];
  } catch (error) {
    elizaLogger.error("❌ Error getting user wallets", {
      normalizedUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return [];
  }
}

/**
 * Normalize legacy status values to current standard values
 */
function normalizeStatus(status: string): string {
    const statusMap: Record<string, string> = {
        'registered': 'active',
        'complete': 'active',
        'valid': 'active',
        'confirmed': 'active',
        'verified': 'active'
    };
    
    return statusMap[status.toLowerCase()] || status;
}

/**
 * Get pending registration with optimized querying and cleanup
 */
export async function getPendingRegistration(runtime: IAgentRuntime, userId: string, roomId?: string): Promise<PendingWalletRegistration | null> {
    try {
        // Clean up old cancelled registrations first to avoid confusion
        await cleanupOldCancelledRegistrations(runtime);
        
        // Extract raw Discord ID for alternative lookup (e.g. USERID:12345678 -> 12345678)
        const rawDiscordId = extractRawDiscordId(userId);
        const normalizedUserId = userId.toUpperCase();
        
        // Enhanced diagnostic logging for wallet registration
        elizaLogger.info("WALLET_DEBUG: GETTING PENDING REGISTRATION", {
            operation: "getPendingRegistration",
            userId,
            normalizedUserId,
            rawDiscordId,
            roomId,
            queryTargets: {
                original: userId,
                normalized: normalizedUserId,
                rawDiscord: rawDiscordId
            }
        });
        
        // First attempt to get pending registrations with normal filter
        elizaLogger.info("Querying pending registration...", {
            operation: "getPendingRegistration",
            userId,
            roomId
        });
        
        const treasuryRoomId = roomId || CONVERSATION_ROOM_ID;
        
        // ATTEMPT 1: Try with original user ID
        let pendingRegistrations = await queryMemoriesWithFilters(
            runtime,
            treasuryRoomId,
            {
                "content.type": "pending_wallet_registration",
                "content.userId": userId,
                "content.status": "pending",
                // Add special flag to force strictest type checking
                _treasuryOperation: true,
                _requireExactTypeMatch: true
            },
            1
        );
        
        // ATTEMPT 2: If first attempt failed or returned no results and we have a raw ID, try with raw Discord ID
        if (pendingRegistrations.length === 0 && rawDiscordId) {
            try {
                elizaLogger.info("Trying with raw Discord ID for pending registrations", {
                    operation: "getPendingRegistration",
                    userId,
                    rawDiscordId,
                    useRawId: true
                });
                
                pendingRegistrations = await queryMemoriesWithFilters(
                    runtime,
                    treasuryRoomId,
                    {
                        "content.type": "pending_wallet_registration",
                        "content.userId": rawDiscordId,
                        "content.status": "pending",
                        _treasuryOperation: true,
                        _requireExactTypeMatch: true
                    },
                    1
                );
                
                elizaLogger.debug("Pending registration query with Treasury markers (raw Discord ID)", {
                    operation: "getPendingRegistration",
                    found: pendingRegistrations.length > 0,
                    count: pendingRegistrations.length,
                    rawDiscordId: rawDiscordId
                });
            } catch (rawIdQueryError) {
                elizaLogger.warn("Error querying pending registrations with Treasury markers (raw Discord ID)", {
                    operation: "getPendingRegistration",
                    error: rawIdQueryError instanceof Error ? rawIdQueryError.message : String(rawIdQueryError),
                    rawDiscordId: rawDiscordId
                });
            }
        }
        
        // ATTEMPT 3: If previous attempts failed or returned no results, try with minimal query (UUID)
        if (pendingRegistrations.length === 0) {
            try {
                elizaLogger.info("Trying simplified query for pending registrations (UUID)", {
                    operation: "getPendingRegistration",
                    userId: userId
                });
                
                pendingRegistrations = await queryMemoriesWithFilters(
                    runtime,
                    treasuryRoomId,
                    {
                        "content.type": "pending_wallet_registration",
                        "content.userId": userId
                    },
                    1
                );
                
                elizaLogger.debug("Pending registration query with simplified parameters (UUID)", {
                    operation: "getPendingRegistration",
                    found: pendingRegistrations.length > 0,
                    count: pendingRegistrations.length,
                    userId: userId
                });
            } catch (simpleQueryError) {
                elizaLogger.warn("Error with simplified query for pending registrations (UUID)", {
                    operation: "getPendingRegistration",
                    error: simpleQueryError instanceof Error ? simpleQueryError.message : String(simpleQueryError),
                    userId: userId
                });
            }
        }
        
        // ATTEMPT 4: If still no results and we have a raw ID, try with minimal query using raw Discord ID
        if (pendingRegistrations.length === 0 && rawDiscordId) {
            try {
                elizaLogger.info("Trying simplified query for pending registrations (raw Discord ID)", {
                    operation: "getPendingRegistration",
                    userId,
                    rawDiscordId
                });
                
                pendingRegistrations = await queryMemoriesWithFilters(
                    runtime,
                    treasuryRoomId,
                    {
                        "content.type": "pending_wallet_registration",
                        "content.userId": rawDiscordId
                    },
                    1
                );
                
                elizaLogger.debug("Pending registration query with simplified parameters (raw Discord ID)", {
                    operation: "getPendingRegistration",
                    found: pendingRegistrations.length > 0,
                    count: pendingRegistrations.length,
                    rawDiscordId: rawDiscordId
                });
            } catch (simpleRawIdQueryError) {
                elizaLogger.warn("Error with simplified query for pending registrations (raw Discord ID)", {
                    operation: "getPendingRegistration",
                    error: simpleRawIdQueryError instanceof Error ? simpleRawIdQueryError.message : String(simpleRawIdQueryError),
                    rawDiscordId: rawDiscordId
                });
            }
        }

        // If no results after all attempts, return null
        if (pendingRegistrations.length === 0) {
            elizaLogger.info("No pending registration found after all attempts", {
                operation: "getPendingRegistration",
                userId: userId,
                rawDiscordId: rawDiscordId
            });
            return null;
        }

        // Check the first registration
        const registration = pendingRegistrations[0]?.content as unknown as PendingWalletRegistration;
        
        // Validate the registration structure
        if (!registration || !registration.walletAddress || !registration.status) {
            elizaLogger.warn("Invalid pending registration structure", {
                operation: "getPendingRegistration",
                registration: JSON.stringify(registration),
                userId: userId
            });
            return null;
        }

        // Enhanced validation for wallet address format
        const walletAddressStr = String(registration.walletAddress);
        const validWalletFormat = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddressStr);
        if (!validWalletFormat) {
            elizaLogger.warn("Invalid wallet address format in pending registration", {
                operation: "getPendingRegistration",
                walletAddress: walletAddressStr,
                isFormatValid: validWalletFormat,
                walletLength: walletAddressStr.length,
                userId: userId,
                source: registration.source ? String(registration.source) : 'unknown'
            });
            // We don't return null here to maintain backward compatibility, but we log the issue
        }

        elizaLogger.info("Found pending registration", {
            operation: "getPendingRegistration",
            details: {
                walletAddress: registration.walletAddress,
                status: registration.status,
                userId: registration.userId,
                memoryUUID: pendingRegistrations[0].id
            }
        });
        
        // Add detailed diagnostic logging for debugging
        logDiagnostic("Pending Registration Structure Analysis", {
            walletAddress: String(registration.walletAddress),
            walletLength: String(registration.walletAddress).length,
            status: registration.status,
            userId: registration.userId,
            hasMissingFields: !registration.walletAddress || !registration.status || !registration.userId,
            allKeys: Object.keys(registration),
            contentType: registration.type || "not_specified",
            source: registration.source || "unknown"
        });
        
        return registration;
    } catch (error) {
        elizaLogger.error("Error getting pending registration", {
            operation: "getPendingRegistration",
            error: error instanceof Error ? error.message : String(error),
            userId: userId
        });
        return null;
    }
}

/**
 * Helper function to query memories with filters
 */
async function queryMemoriesWithFilters(
    runtime: IAgentRuntime, 
    roomId: string, 
    filter: any, 
    count: number = 10,
    sortBy: string = "updatedAt",
    sortDirection: string = "desc"
): Promise<Memory[]> {
    const memoryManager = runtime.messageManager as any;
    try {
        return await memoryManager.getMemoriesWithFilters({
            roomId,
            filter,
            count,
            sortBy,
            sortDirection
        });
    } catch (error) {
        elizaLogger.warn("Error querying memories with filters", {
            error: error instanceof Error ? error.message : String(error),
            roomId,
            filter: JSON.stringify(filter)
        });
        return [];
    }
}

/**
 * Cleanup old cancelled registrations to prevent memory buildup
 */
async function cleanupOldCancelledRegistrations(runtime: IAgentRuntime): Promise<void> {
    try {
        const ONE_DAY = 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        elizaLogger.debug("Looking for old cancelled wallet registrations to clean up", {
            operation: "cleanupOldCancelledRegistrations",
            roomId: CONVERSATION_ROOM_ID,
            _treasuryOperation: true
        });
        
        let oldCancelled = [];
        
        try {
            // Find old cancelled registrations with Treasury operation markers
            oldCancelled = await queryMemoriesWithFilters(
                runtime,
                CONVERSATION_ROOM_ID,
                {
                    "content.type": "pending_wallet_registration",
                    "content.status": "cancelled",
                    "content.updatedAt": { $lt: now - ONE_DAY },
                    _treasuryOperation: true
                },
                50
            );
            
            elizaLogger.debug("Retrieved cancelled registrations with Treasury markers", {
                operation: "cleanupOldCancelledRegistrations",
                count: oldCancelled.length,
                roomId: CONVERSATION_ROOM_ID
            });
        } catch (queryError) {
            // Log error and proceed to try simpler query
            elizaLogger.warn("Error retrieving cancelled registrations with Treasury markers", {
                operation: "cleanupOldCancelledRegistrations",
                error: queryError instanceof Error ? queryError.message : String(queryError),
                roomId: CONVERSATION_ROOM_ID
            });
        }
        
        // If no old cancelled registrations found with Treasury markers, try simplified query
        if (oldCancelled.length === 0) {
            try {
                // Try with simpler query without Treasury markers
                oldCancelled = await queryMemoriesWithFilters(
                    runtime,
                    CONVERSATION_ROOM_ID,
                    {
                        "content.type": "pending_wallet_registration",
                        "content.status": "cancelled",
                        "content.updatedAt": { $lt: now - ONE_DAY }
                    },
                    50
                );
                
                elizaLogger.debug("Retrieved cancelled registrations with simple query", {
                    operation: "cleanupOldCancelledRegistrations",
                    count: oldCancelled.length,
                    roomId: CONVERSATION_ROOM_ID
                });
            } catch (simpleQueryError) {
                elizaLogger.warn("Error retrieving cancelled registrations with simple query", {
                    operation: "cleanupOldCancelledRegistrations",
                    error: simpleQueryError instanceof Error ? simpleQueryError.message : String(simpleQueryError),
                    roomId: CONVERSATION_ROOM_ID
                });
            }
        }

        // Delete old cancelled registrations
        let deleteSuccessCount = 0;
        let deleteFailCount = 0;
        
        for (const reg of oldCancelled) {
            try {
                await runtime.messageManager.removeMemory(reg.id);
                deleteSuccessCount++;
            } catch (removeError) {
                deleteFailCount++;
                elizaLogger.warn("Failed to remove cancelled registration", {
                    operation: "cleanupOldCancelledRegistrations",
                    memoryId: reg.id,
                    error: removeError instanceof Error ? removeError.message : String(removeError),
                    roomId: CONVERSATION_ROOM_ID,
                    _treasuryOperation: true
                });
                // Continue with other deletions even if one fails
                continue;
            }
        }

        if (oldCancelled.length > 0) {
            elizaLogger.info("Cleaned up old cancelled registrations", {
                operation: "cleanupOldCancelledRegistrations",
                roomId: CONVERSATION_ROOM_ID,
                count: oldCancelled.length,
                deleteSuccessCount,
                deleteFailCount,
                _treasuryOperation: true
            });
        }
    } catch (error) {
        // Log error but don't throw - cleanup failure shouldn't block registration
        elizaLogger.error("Error cleaning up old cancelled registrations", {
            operation: "cleanupOldCancelledRegistrations",
            roomId: CONVERSATION_ROOM_ID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
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
export async function createPendingRegistration(
  memoryManager: any,
  agent: any,
  userId: UUID,
  newWalletAddress: string,
  existingWallets: Array<{ walletAddress: string; status: string }>,
  flow: string = "standard",
  source: string = "unknown"
): Promise<void> {
  try {
    // Extract the raw Discord ID for reference only
    const rawDiscordId = extractRawDiscordId(userId.toString());
    
    // Ensure userId is fully normalized for consistent storage and lookup
    const normalizedUserId = normalizeUserId(userId.toString()) || userId.toString();
    
    // Validate and clean wallet address first
    const cleanWalletAddress = newWalletAddress.trim();
    const isValidFormat = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanWalletAddress);
    
    elizaLogger.info("Creating pending wallet registration", {
      userId: normalizedUserId,
      rawDiscordId: rawDiscordId,
      newWalletAddress: cleanWalletAddress,
      walletAddressLength: cleanWalletAddress.length,
      isValidWalletFormat: isValidFormat,
      existingWallets: existingWallets?.length || 0,
      roomId: CONVERSATION_ROOM_ID,
      operation: "createPendingRegistration",
      flow,
      source
    });
    
    // Add wallet validation diagnostic
    logDiagnostic("Wallet Address Validation", {
      originalWallet: newWalletAddress,
      cleanedWallet: cleanWalletAddress,
      walletLength: cleanWalletAddress.length,
      isValidFormat,
      userId: normalizedUserId
    });
    
    const id = stringToUuid(v4());
    const walletToRegister = cleanWalletAddress;
    
    const pendingRegistration = {
      id,
      roomId: CONVERSATION_ROOM_ID,
      _treasuryOperation: true,
      type: "pending_wallet_registration",
      content: {
        type: "pending_wallet_registration",
        userId: normalizedUserId,
        walletAddress: walletToRegister,
        timestamp: new Date().toISOString(),
        status: "pending",
        requiredConfirmation: true,
        expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes from now
        createdAt: Date.now(),
        updatedAt: Date.now(),
        existingWallets: existingWallets || [],
        metadata: {
          flow,
          source,
          rawDiscordId: rawDiscordId // Store raw ID for reference only
        }
      },
      metadata: {
        _treasuryOperation: true,
        source: "registerHandler",
        agentType: "TREASURY",
        rawDiscordId: rawDiscordId
      }
    };
    
    try {
      await memoryManager.createMemory(pendingRegistration);
      elizaLogger.info("Created pending registration", {
        operation: "createPendingRegistration",
        userId: normalizedUserId, 
        rawDiscordId: rawDiscordId, // Log the raw ID for reference
        walletAddress: walletToRegister,
        memoryId: id,
        roomId: CONVERSATION_ROOM_ID,
        flow,
        source
      });
    } catch (memoryError) {
      elizaLogger.error("Failed to create pending registration memory", {
        operation: "createPendingRegistration",
        userId: normalizedUserId,
        rawDiscordId: rawDiscordId, // Log the raw ID as well
        walletAddress: walletToRegister,
        error: memoryError instanceof Error ? memoryError.message : String(memoryError),
        flow,
        source
      });
      throw memoryError;
    }
    
    // Create a system message to user to ask for confirmation
    await agent.sendMessage(`I found ${existingWallets?.length || 0} existing wallets registered to you. 
Would you like to register an additional wallet (${walletToRegister})? 
Please reply with 'yes' to confirm or 'no' to cancel.`);
    
  } catch (error) {
    elizaLogger.error("Failed to create pending wallet registration", {
      userId: userId.toString(),
      walletAddress: newWalletAddress,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      roomId: CONVERSATION_ROOM_ID,
      _treasuryOperation: true,
      flow,
      source
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
  try {
    // Extract the raw Discord ID for reference only
    const rawDiscordId = extractRawDiscordId(userId.toString());
    
    // Ensure userId is fully normalized for consistent storage and lookup
    const normalizedUserId = normalizeUserId(userId.toString()) || userId.toString();
    
    elizaLogger.info("Canceling all pending wallet registrations", {
      userId: normalizedUserId,
      rawDiscordId: rawDiscordId,
      reason,
      operation: "cancelAllPendingRegistrations"
    });
    
    // Query using the normalized ID
    const pendingMemories = await memoryManager.getMemories({
      roomId: CONVERSATION_ROOM_ID,
      filter: {
        "content.type": "pending_wallet_registration",
        "content.userId": normalizedUserId,
        "content.status": "pending"
      },
      _treasuryOperation: true
    } as any);
    
    elizaLogger.info(`Found ${pendingMemories?.length || 0} pending registrations to cancel`, {
      userId: normalizedUserId,
      rawDiscordId: rawDiscordId,
      operation: "cancelAllPendingRegistrations"
    });
    
    // If no pending registrations, just exit
    if (!pendingMemories || pendingMemories.length === 0) {
      elizaLogger.info(`No pending registrations found to cancel`, {
        userId: normalizedUserId,
        operation: "cancelAllPendingRegistrations"
      });
      return;
    }

    for (const registration of pendingMemories) {
      const pending = registration.content as PendingWalletRegistration;
      const now = Date.now();
      
      elizaLogger.debug("Cancelling registration", {
        userId: pending.userId,
        walletAddress: pending.newWalletAddress,
        registrationId: registration.id
      });
      
      await memoryManager.createMemory({
        id: stringToUuid(`cancelled-registration-${userId}-${now}`),
        roomId: CONVERSATION_ROOM_ID,
        type: "pending_wallet_registration",
        content: {
          type: "pending_wallet_registration",
          userId: pending.userId, // Keep original format that was used
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
  } catch (error) {
    elizaLogger.error("Error canceling all pending registrations", {
      operation: "cancelAllPendingRegistrations",
      error: error instanceof Error ? error.message : String(error),
      userId: userId?.toString()
    });
    throw error;
  }
}

/**
 * Extract potential raw Discord ID from a UUID
 * This is a heuristic approach since we don't have direct access to the conversion algorithm
 */
function extractRawDiscordId(userId: string): string {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  // If userId is already in raw format, return it
  if (!uuidPattern.test(userId)) {
    return userId;
  }
  
  // Extract the raw Discord ID from UUID format
  const parts = userId.split('-');
  if (parts.length >= 1) {
    const firstPart = parts[0];
    // Log the extraction for debugging
    elizaLogger.debug(`Extracted raw Discord ID ${firstPart} from UUID ${userId}`, {
      operation: 'extractRawDiscordId',
      originalId: userId,
      extractedId: firstPart
    });
    return firstPart;
  }
  
  // Fallback to original if extraction fails
  return userId;
}

/**
 * Extract text from a message regardless of message format
 */
function extractMessageText(message: AgentMessage & ExtendedAgentMessage): string | undefined {
  // Try getting text directly from message content
  if (message.content?.text) {
    return message.content.text;
  }
  
  // For compatibility with different message formats
  if (typeof message.content === 'string') {
    return message.content;
  }
  
  // For message objects that might have text in a different structure
  if (message.content && typeof message.content === 'object') {
    return (message.content as any).content || (message.content as any).text;
  }
  
  return undefined;
}

/**
 * Handle a registration command
 */
export async function handleRegisterCommand(
    agent: any, 
    message: AgentMessage & ExtendedAgentMessage,
    callback?: (response: Content) => Promise<void>
): Promise<void> {
    try {
        const runtime = agent.getRuntime();
        const userId = message.userId || getUserIdFromMessage(message);
        const normalizedUserId = userId;
        const rawDiscordId = extractRawDiscordId(userId);

        elizaLogger.info(`🔑 Received register command from user`, {
            userId: normalizedUserId,
            rawDiscordId,
            messageId: (message as any).id || 'unknown',
            contentAvailable: !!message.content,
            flowStage: 'start'
        });

        // Extract wallet address from message text or content
        const messageText = extractMessageText(message) || '';
        
        // Log the exact message text to see what we're parsing
        elizaLogger.debug(`📄 Processing message text for wallet extraction:`, {
            messageTextPreview: messageText.substring(0, 100) + (messageText.length > 100 ? '...' : ''),
            messageLength: messageText.length,
            matchesRegisterCommand: messageText.toLowerCase().includes('register'),
            flowStage: 'text_extraction'
        });
        
        // Extract wallet address from message
        let flowStage = "extracting_wallet_address";
        const walletAddress = extractWalletFromMultiline(messageText);
        if (!walletAddress) {
            elizaLogger.info("No wallet address found in message", { 
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

        // Add diagnostic for extracted wallet address validation
        const cleanWalletAddress = walletAddress.trim();
        const isValidFormat = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanWalletAddress);
        
        logDiagnostic("Extracted Wallet Address Verification", {
            originalWallet: walletAddress,
            cleanedWallet: cleanWalletAddress,
            walletLength: cleanWalletAddress.length,
            isValidFormat,
            messageLength: messageText.length,
            messagePreview: messageText.substring(0, 50) + (messageText.length > 50 ? "..." : ""),
            userId: normalizedUserId.toString()
        });

        // Try to find existing wallets
        flowStage = "search_existing";
        elizaLogger.info(`🔍 Searching for existing wallets for user`, {
            userId: normalizedUserId,
            rawDiscordId,
            flowStage
        });
        
        const existingWallets = await getUserWallets(runtime, normalizedUserId);
        
        elizaLogger.info(`✓ Found ${existingWallets.length} existing ${existingWallets.length === 1 ? 'wallet' : 'wallets'} for user`, {
            userId: normalizedUserId,
            rawDiscordId,
            walletCount: existingWallets.length,
            existingWallets: existingWallets.map(w => ({ 
                address: w.walletAddress ? w.walletAddress.substring(0, 8) + '...' : 'missing',
                status: w.status || 'unknown'
            })),
            flowStage: 'existing_wallets'
        });

        // Check for pending registration
        flowStage = "checking_pending_registration";
        elizaLogger.info("Checking for pending registration", {
            userId: userId.toString(),
            walletAddress,
            flowStage
        });
        
        const pendingReg = await getPendingRegistration(runtime, userId);
        
        // If pending registration exists, handle confirmation/cancellation flow
        if (pendingReg) {
            flowStage = "handling_pending_registration";
            elizaLogger.info("Found pending registration", {
                userId: userId.toString(),
                pendingWallet: pendingReg.newWalletAddress,
                walletToRegister: messageText,
                existingWallets: pendingReg.existingWallets?.length,
                flowStage
            });

            const isConfirmation = detectConfirmationIntent(messageText);
            const isCancellation = detectCancellationIntent(messageText);
            
            // Log user intent detection
            elizaLogger.info("Detected user intent", {
                userId: userId.toString(),
                messageText: messageText.substring(0, 50),
                isConfirmation,
                isCancellation,
                flowStage
            });

            if (isConfirmation) {
                // User confirmed - proceed with registration
                flowStage = "processing_confirmation";
                elizaLogger.info("User confirmed pending registration", {
                    userId: userId.toString(),
                    newWallet: messageText,
                    flowStage
                });

                // Extract the raw Discord ID for reference only
                const rawDiscordId = extractRawDiscordId(userId.toString());
                
                // Ensure userId is fully normalized for consistent storage and lookup
                const normalizedUserId = normalizeUserId(userId.toString()) || userId.toString();

                // Create the registration memory
                const id = stringToUuid(v4());
                const registrationMemory = {
                    id: id,
                    roomId: CONVERSATION_ROOM_ID,
                    _treasuryOperation: true,
                    type: "wallet_registration",
                    content: {
                        type: "wallet_registration",
                        userId: normalizedUserId,
                        walletAddress: pendingReg.newWalletAddress,
                        timestamp: new Date().toISOString(),
                        status: "active",
                        registrationType: "confirmed",
                        _treasuryOperation: true,
                        metadata: {
                            rawDiscordId: rawDiscordId
                        }
                    },
                    metadata: {
                        _treasuryOperation: true,
                        source: "registerHandler",
                        agentType: "TREASURY",
                        rawDiscordId: rawDiscordId
                    }
                };

                elizaLogger.info("Creating wallet registration memory after confirmation", {
                    userId: normalizedUserId,
                    rawDiscordId: rawDiscordId,
                    walletAddress: pendingReg.newWalletAddress,
                    roomId: CONVERSATION_ROOM_ID,
                    memoryId: registrationMemory.id,
                    flowStage
                });

                // Log explicit details for debugging
                elizaLogger.info("FINAL WALLET REGISTRATION: Creating with explicit Treasury markers", {
                    userId: normalizedUserId,
                    rawDiscordId: rawDiscordId,
                    walletAddress: pendingReg.newWalletAddress,
                    roomId: CONVERSATION_ROOM_ID,
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

                // Add detailed memory storage verification logging
                elizaLogger.info("MEMORY STORAGE VERIFICATION - Confirmation Flow", {
                    operation: "handleRegisterCommand",
                    flowStage: "confirmation_memory_verification",
                    storedMemory: JSON.stringify({
                        id: registrationMemory.id,
                        userId: registrationMemory.content.userId,
                        roomId: registrationMemory.roomId,
                        _treasuryOperation: registrationMemory._treasuryOperation,
                        content: registrationMemory.content,
                        metadata: registrationMemory.metadata
                    }, null, 2),
                    contentFields: Object.keys(registrationMemory.content),
                    hasWalletAddress: !!registrationMemory.content.walletAddress,
                    hasType: !!registrationMemory.content.type,
                    hasStatus: !!registrationMemory.content.status,
                    _treasuryOperation: true
                });

                // Mark old wallets as inactive
                flowStage = "deactivating_old_wallets";
                elizaLogger.info("Marking old wallets as inactive", {
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
                elizaLogger.info("User cancelled pending registration", {
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
                elizaLogger.info("User needs to confirm or cancel", {
                    userId: userId.toString(),
                    flowStage
                });
                
                if (callback) {
                    await callback({
                        type: "response",
                        text: `You have a pending wallet registration. Please type 'confirm' to proceed with registering ${messageText} or 'cancel' to keep your existing wallet(s).`
                    });
                }
            }
            return;
        }

        // No pending registration - check if user has existing wallets
        if (existingWallets.length > 0) {
            // Create pending registration
            flowStage = "creating_pending_registration";
            elizaLogger.info("User has existing wallets, creating pending registration", {
                userId: userId.toString(),
                existingWalletCount: existingWallets.length,
                newWalletAddress: messageText,
                flowStage,
                existingWallets: existingWallets.map(w => ({
                    address: truncateAddress(w.walletAddress),
                    status: w.status
                }))
            });
            
            elizaLogger.info("Creating new pending registration for user", {
                userId: userId.toString(),
                walletAddress: walletAddress,
                messageText: messageText.substring(0, 50) + "...",
                flowStage: 'create_pending'
            });
            
            // Create pending registration to trigger multi-step flow
            await createPendingRegistration(agent.getRuntime().messageManager, agent, userId, walletAddress, existingWallets, "standard", "user_initiated");
            
            const walletList = existingWallets
                .map(w => `${truncateAddress(w.walletAddress)} (${w.status})`)
                .join(", ");
            
            if (callback) {
                await callback({
                    type: "response",
                    text: `You already have registered wallet(s): ${walletList}. Please type 'confirm' to replace them with ${walletAddress} or 'cancel' to keep your existing wallet(s).`
                });
            }
            return;
        }

        // Proceed with direct registration since no existing wallets were found
        flowStage = "direct_registration";
        elizaLogger.info("Proceeding with direct registration - no existing wallets found", {
            userId: userId.toString(),
            rawDiscordId: rawDiscordId,
            extractedWallet: walletAddress,
            messageText: messageText.substring(0, 50) + "...",
            flowStage,
            verificationComplete: true
        });
        
        const id = stringToUuid(v4());
        const registrationMemory = {
            id: id,
            roomId: CONVERSATION_ROOM_ID,
            _treasuryOperation: true,
            type: "wallet_registration",
            content: {
                type: "wallet_registration",
                userId: userId,
                walletAddress: walletAddress,
                timestamp: new Date().toISOString(),
                status: "active",
                registrationType: "direct",
                _treasuryOperation: true
            },
            metadata: {
                _treasuryOperation: true,
                source: "registerHandler",
                agentType: "TREASURY",
                registrationType: "direct",
                verificationComplete: true
            }
        };

        elizaLogger.info("Creating new wallet registration memory", {
            userId: userId.toString(),
            walletAddress: walletAddress,
            roomId: CONVERSATION_ROOM_ID,
            memoryId: registrationMemory.id,
            flowStage,
            registrationType: "direct"
        });

        // Log explicit details for debugging
        elizaLogger.info("FINAL WALLET REGISTRATION: Creating with explicit Treasury markers", {
            userId: userId.toString(),
            walletAddress: walletAddress,
            roomId: CONVERSATION_ROOM_ID,
            isTreasuryOperation: true,
            operation: "handleRegisterCommand",
            memoryId: registrationMemory.id,
            flowStage,
            registrationType: "direct"
        });

        // Create with explicit Treasury operation context
        await agent.getRuntime().messageManager.createMemory({
            ...registrationMemory,
            metadata: {
                ...registrationMemory.metadata,
                _treasuryOperation: true,
            }
        });

        // Add detailed memory storage verification logging
        elizaLogger.info("MEMORY STORAGE VERIFICATION - Direct Registration Flow", {
            operation: "handleRegisterCommand",
            flowStage: "direct_registration_memory_verification",
            storedMemory: JSON.stringify({
                id: registrationMemory.id,
                userId: registrationMemory.content.userId,
                roomId: registrationMemory.roomId,
                _treasuryOperation: registrationMemory._treasuryOperation,
                content: registrationMemory.content,
                metadata: registrationMemory.metadata
            }, null, 2),
            contentFields: Object.keys(registrationMemory.content),
            hasWalletAddress: !!registrationMemory.content.walletAddress,
            hasType: !!registrationMemory.content.type,
            hasStatus: !!registrationMemory.content.status,
            _treasuryOperation: true
        });

        if (callback) {
            await callback({
                type: "response",
                text: "Wallet successfully registered! This is your first registered wallet."
            });
        }
    } catch (error) {
        elizaLogger.error("Error in handleRegisterCommand", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            userId: getUserIdFromMessage(message).toString(),
            flowStage: "error"
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
    const runtime = agent.getRuntime();
    if (!runtime || !runtime.messageManager) {
      elizaLogger.error("Cannot mark wallet inactive - missing runtime or messageManager");
      return false;
    }
    
    // Always normalize userId for consistent lookup
    const normalizedUserId = normalizeUserId(userId.toString()) || userId.toString();
    const rawDiscordId = extractRawDiscordId(userId.toString());
    
    elizaLogger.info("Marking wallet as inactive", {
      normalizedUserId,
      rawDiscordId, 
      walletAddress,
      operation: "markWalletInactive"
    });
    
    // Find the wallet registration
    const walletMemories = await runtime.messageManager.getMemories({
      roomId: CONVERSATION_ROOM_ID,
      filter: {
        "content.type": "wallet_registration",
        "content.userId": normalizedUserId,
        "content.walletAddress": walletAddress,
        "content.status": "active",
      },
      _treasuryOperation: true
    } as any);
    
    if (!walletMemories || walletMemories.length === 0) {
      elizaLogger.warn("Could not find active wallet to mark inactive", {
        normalizedUserId,
        rawDiscordId,
        walletAddress,
        operation: "markWalletInactive"
      });
      return false;
    }

    // Create a new memory with inactive status
    await runtime.messageManager.createMemory({
      id: stringToUuid(v4()),
      userId: normalizedUserId, // Use normalized userId
      roomId: CONVERSATION_ROOM_ID, // Changed from ROOM_IDS.DAO
      content: {
        type: "wallet_registration",
        userId: normalizedUserId, // Use normalized userId
        walletAddress: walletAddress,
        status: "inactive" as ContentStatus,
        text: `Wallet registration deactivated: ${walletAddress}`,
        createdAt: walletMemories[0].content.createdAt,
        updatedAt: Date.now(),
        metadata: {
            ...walletMemories[0].content.metadata,
            rawDiscordId, // Store raw ID for reference
            deactivatedAt: Date.now(),
            reason: "User requested deactivation"
        }
      },
      _treasuryOperation: true
    });

    elizaLogger.info("Successfully marked wallet as inactive", {
      normalizedUserId,
      rawDiscordId,
      walletAddress, 
      operation: "markWalletInactive"
    });
    
    return true;
  } catch (error) {
    elizaLogger.error("Error marking wallet as inactive", {
      userId: userId.toString(),
      walletAddress,
      error: error.message,
      operation: "markWalletInactive"
    });
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