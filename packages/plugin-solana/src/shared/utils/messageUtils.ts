// MessageUtils.ts

import { elizaLogger, stringToUuid, UUID, Memory } from "@elizaos/core";
import { AgentMessage } from "../types/base.ts";
import { ROOM_IDS } from "../constants.ts";
import { getValidatedUserIdFromMessage } from "./userUtils.ts";
import { v4 } from "uuid";

// Set of message IDs we've already stored during this session
// This provides session deduplication without database lookups
const storedMessageIds = new Set<string>();

// Map to track message content to detect true duplicates
// Format: { messageId: { text: string, createdAt: number } }
const messageContentMap = new Map<string, { text: string, createdAt: number }>();

// Define the conversation room ID to match the one in constants.ts
export const CONVERSATION_ROOM_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Standardizes a room ID to ensure consistent retrieval
 * If no roomId is provided or it's invalid, returns the default conversation room ID
 * 
 * @param roomId The room ID to standardize
 * @returns Standardized room ID
 */
export function getStandardizedRoomId(roomId?: string): string {
  // If no roomId provided, use default
  if (!roomId) {
    elizaLogger.debug(`No roomId provided, using standard conversation room ID: ${CONVERSATION_ROOM_ID}`);
    return CONVERSATION_ROOM_ID;
  }

  // Handle nullish values
  if (roomId === "null" || roomId === "undefined") {
    elizaLogger.warn(`Invalid roomId "${roomId}" replaced with standard conversation room ID`);
    return CONVERSATION_ROOM_ID;
  }

  // Validate UUID format (basic check)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(roomId)) {
    elizaLogger.warn(`Non-UUID roomId "${roomId}" replaced with standard conversation room ID`);
    return CONVERSATION_ROOM_ID;
  }

  // If it's already the conversation room ID, just return it
  if (roomId === CONVERSATION_ROOM_ID) {
    return roomId;
  }

  // For now, we'll standardize all roomIds to the conversation room ID
  // This ensures a consistent experience while we debug embedding issues
  elizaLogger.info(`Standardizing roomId from ${roomId} to ${CONVERSATION_ROOM_ID} for consistent retrieval`);
  return CONVERSATION_ROOM_ID;
}

/**
 * Extract the text content from a message 
 * @param message The message to extract text from
 * @returns The extracted text or an empty string if no text is found
 */
function extractMessageText(message: AgentMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  } else if (message.content?.text) {
    return message.content.text;
  } else {
    return '';
  }
}

/**
 * Stores a user message with deduplication to prevent duplicates
 * @param runtime The agent runtime
 * @param message The message to store
 * @param agentId The agent ID
 * @returns The ID of the stored memory, or null if it's a duplicate
 */
export async function storeUserMessageWithDeduplication(
  runtime: any,
  message: AgentMessage,
  agentId: UUID
): Promise<UUID | null> {
  try {
    const messageId = (message as any).id || stringToUuid(v4());
    const userId = getValidatedUserIdFromMessage(message).userId;
    const roomId = (message as any).roomId || agentId;
    const text = extractMessageText(message);
    
    // Skip if we've already processed this message ID this session
    if (storedMessageIds.has(messageId)) {
      elizaLogger.debug(`Skipping already processed message: ${messageId}`);
      return null;
    }
    
    // ENHANCED DETECTION: Check if this is a wallet registration message
    const messageText = (text || '').toLowerCase();
    const isWalletRegistrationMsg = 
      // More comprehensive text pattern matching
      messageText.includes("register my wallet") || 
      messageText.includes("!register") ||
      messageText.includes("register wallet") ||
      messageText.includes("wallet registration") ||
      messageText.includes("register my sol") ||
      messageText.includes("register sol") ||
      messageText.includes("register address") ||
      messageText.includes("add my wallet") ||
      messageText.includes("add wallet");
    
    // Create the memory with proper user message type
    const userMemory: Memory = {
      id: messageId,
      userId,
      roomId,
      agentId,
      content: {
        type: "user_message", // Always use user_message for raw user input
        text,
        createdAt: Date.now(),
        metadata: {
          messageSource: (message as any).source || "unknown",
          hasWalletRegistrationIntent: isWalletRegistrationMsg,
          originalType: message.content?.type // Preserve original type in metadata
        }
      }
    };

    // Enhanced wallet registration logging
    if (isWalletRegistrationMsg) {
      elizaLogger.info("WALLET REGISTRATION INTENT DETECTED IN USER MESSAGE", {
        operation: "storeUserMessageWithDeduplication",
        messageId,
        userId: userId.toString(),
        text: messageText.substring(0, 100),
        roomId: ROOM_IDS.DAO,
        _treasuryOperation: true
      });
    }
    
    // Check if this is a Treasury operation to avoid standardizing the room ID
    const isTreasuryOperation = 
      // Content type checks
      message.content?.type === "wallet_registration" ||
      message.content?.type === "pending_wallet_registration" ||
      message.content?.action === "register" ||
      message.content?.type === "register_response" ||
      // Enhanced wallet registration text detection
      isWalletRegistrationMsg ||
      // Consider runtime agent type
      (runtime.agentType === "TREASURY") ||
      // If this message already has DAO room ID, preserve it
      (message as any).roomId === ROOM_IDS.DAO ||
      // Direct request to preserve room ID
      (message as any)._treasuryOperation === true;
    
    // Force DAO room for explicit wallet registration operations
    let finalRoomId = roomId;
    if (isWalletRegistrationMsg || 
        message.content?.type === "wallet_registration" || 
        message.content?.type === "pending_wallet_registration") {
      // CRITICAL FIX: Always use DAO room for wallet-related operations
      finalRoomId = ROOM_IDS.DAO;
      elizaLogger.info("WALLET REGISTRATION DETECTED: Forcing DAO room", {
        operation: "storeUserMessageWithDeduplication",
        messageId,
        contentType: message.content?.type,
        originalRoomId: roomId,
        finalRoomId: ROOM_IDS.DAO,
        text: messageText.substring(0, 100),
        isWalletRegistrationMsg
      });
    } 
    // Only standardize room ID for non-Treasury operations
    else if (!isTreasuryOperation) {
      finalRoomId = getStandardizedRoomId(roomId);
    }
    
    // Log the room ID decision for debugging
    if (isTreasuryOperation) {
      elizaLogger.debug(`Preserving original roomId for Treasury operation: ${roomId}`, {
        operation: "storeUserMessageWithDeduplication",
        messageId,
        contentType: message.content?.type,
        action: message.content?.action,
        text: messageText.substring(0, 50),
        isTreasuryOperation
      });
    } else if (finalRoomId !== roomId) {
      elizaLogger.info(`Standardized roomId: ${roomId} → ${finalRoomId}`, {
        operation: "storeUserMessageWithDeduplication"
      });
    }
    
    const timestamp = Date.now();
    const memory = {
      id: messageId,
      userId,
      roomId: finalRoomId,
      // Add treasury operation marker for wallet registration messages
      _treasuryOperation: isWalletRegistrationMsg || isTreasuryOperation,
      content: {
        ...message.content,
        type: "user_message",
        status: "processed",
        createdAt: timestamp,
        updatedAt: timestamp,
        text,
        // Add a marker in content to help identify wallet registrations
        _isWalletRegistration: isWalletRegistrationMsg,
        _treasuryOperation: isWalletRegistrationMsg || isTreasuryOperation
      }
    };

    // Store the memory
    await runtime.messageManager.createMemory(memory);
    
    // Mark it as processed for this session
    storedMessageIds.add(messageId);
    
    // Update our deduplication map
    messageContentMap.set(messageId, {
      text,
      createdAt: timestamp
    });
    
    elizaLogger.info("Storing user message memory", {
      messageId,
      type: "user_message",
      status: "processed",
      isWalletRegistration: isWalletRegistrationMsg,
      roomId: finalRoomId
    });
    
    return messageId;
  } catch (error) {
    elizaLogger.error("Error storing user message:", error);
    return null;
  }
}

/**
 * Creates a reference to an existing message
 * 
 * Instead of duplicating content, this creates a reference to the original message
 * with additional context specific to the current agent/situation.
 * 
 * @param runtime The agent runtime
 * @param originalMessageId The ID of the original message
 * @param referenceType The type of the reference (e.g., "proposal_reference", "strategy_reference")
 * @param contextData Additional context data for the reference
 * @param agentId The ID of the agent creating the reference
 * @returns The ID of the created reference
 */
export async function createMessageReference(
  runtime: any,
  originalMessageId: UUID,
  referenceType: string,
  contextData: any,
  agentId: UUID
): Promise<UUID | null> {
  try {
    // Get the original message
    const originalMessage = await runtime.messageManager.getMemoryById(originalMessageId);
    
    if (!originalMessage) {
      elizaLogger.warn("Cannot create reference - original message not found", {
        originalMessageId
      });
      return null;
    }
    
    // Create a new reference ID
    const referenceId = stringToUuid(`ref-${originalMessageId}-${Date.now()}`);
    
    // CRITICAL FIX: Always standardize room ID for references too
    const roomId = getStandardizedRoomId(originalMessage.roomId);
    
    // Create the reference memory
    const referenceMemory = {
      id: referenceId,
      roomId: roomId,  // Using standardized room ID
      agentId: agentId,
      userId: originalMessage.userId,
      content: {
        type: referenceType,
        text: `Reference to message: ${originalMessageId}`,
        originalMessageId: originalMessageId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agentId: agentId,
        // Include the original content type and useful fields
        originalType: originalMessage.content.type,
        originalTimestamp: originalMessage.content.createdAt,
        // Add context specific to this reference
        context: contextData
      }
    };
    
    // Store the reference
    await runtime.messageManager.createMemory(referenceMemory);
    
    elizaLogger.info("Created message reference", {
      referenceId,
      originalMessageId,
      referenceType,
      roomId
    });
    
    return referenceId;
  } catch (error) {
    elizaLogger.error("Failed to create message reference", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      originalMessageId
    });
    
    return null;
  }
}

/**
 * Safely extracts text from various message structures
 * 
 * @param message The message to extract text from
 * @returns The extracted text or null if none found
 */
export function safeExtractMessageText(message: AgentMessage): string | null {
  if (!message?.content) return null;
  
  // Try all possible text locations in order of preference
  if (typeof message.content.text === 'string') {
    return message.content.text;
  }
  
  // Try alternative fields
  const fields = ['message', 'body', 'rawContent'];
  for (const field of fields) {
    if (message.content[field] && typeof message.content[field] === 'string') {
      return message.content[field];
    }
  }
  
  // If content is itself a string (rare but possible)
  if (typeof message.content === 'string') {
    return message.content;
  }
  
  return null;
}

/**
 * Function to extract the user's query text from a memory
 * @param memory The memory potentially containing a user message
 * @returns The extracted text or empty string if not found
 */
export function extractUserQuery(memory: any): string {
  if (!memory || !memory.content) {
    return '';
  }

  const content = memory.content;
  
  // Handle different memory formats
  if (content.type === 'user_message' && typeof content.text === 'string') {
    return content.text;
  }
  
  if (content.from === 'USER' && typeof content.text === 'string') {
    return content.text;
  }
  
  // If we have args array with text
  if (Array.isArray(content.args) && content.args.length > 0) {
    const textArg = content.args.find((arg: any) => 
      typeof arg === 'object' && typeof arg.text === 'string'
    );
    
    if (textArg) {
      return textArg.text;
    }
  }
  
  return '';
}

/**
 * Ensures that memory ID and content ID are consistent
 * This prevents the "one-turn lag" issue by making sure the memory.id and memory.content.id
 * match exactly for comparison purposes in conversation context building
 */
export function ensureConsistentMemoryIds(memory: Memory): Memory {
  if (!memory) return memory;
  
  // If memory has content but IDs don't match, align them
  if (memory.content && memory.id !== memory.content.id) {
    // Use the memory.id as the source of truth
    memory.content.id = memory.id;
    
    // Update timestamps for consistency
    if (!memory.content.updatedAt) {
      memory.content.updatedAt = Date.now();
    }
  }
  
  return memory;
} 