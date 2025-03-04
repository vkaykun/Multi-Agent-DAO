//packages/plugin-solana/src/shared/utils/userUtils.ts

import {
    elizaLogger,
    UUID,
    stringToUuid
} from "@elizaos/core";
import { AgentMessage } from "../types/base.ts";
import { ANONYMOUS_USER_ID } from "../fixes/system-user.ts";
import { ROOM_IDS } from "../constants.ts";
import { CONVERSATION_ROOM_ID } from "./messageUtils.js";

// Define known agent types to avoid treating them as user IDs
const KNOWN_AGENT_TYPES = [
    "TREASURY", 
    "PROPOSAL", 
    "STRATEGY", 
    "USER_PROFILE",
    "SYSTEM",
    "ALL",
    "NONE"
];

/**
 * Validates a message source to determine if it's a real user ID or an agent type
 * @param source The source identifier (typically from message.from)
 * @returns Object containing validation results
 */
export function validateMessageSource(source: unknown): {
    isValidSource: boolean;
    isUserSource: boolean;
    isAgentSource: boolean;
    normalizedId?: UUID;
    agentType?: string;
    confidence: 'high' | 'medium' | 'low' | 'none';
} {
    // Default result structure
    const result = {
        isValidSource: false,
        isUserSource: false,
        isAgentSource: false,
        normalizedId: undefined as UUID | undefined,
        agentType: undefined as string | undefined,
        confidence: 'none' as 'high' | 'medium' | 'low' | 'none'
    };
    
    // Handle null/undefined source
    if (source === null || source === undefined) {
        elizaLogger.debug('Null or undefined message source');
        return result;
    }
    
    // Convert to string for consistent handling
    const sourceStr = String(source).trim();
    
    // Empty sources are invalid
    if (!sourceStr) {
        elizaLogger.debug('Empty message source');
        return result;
    }
    
    // Mark as valid source since we have a non-empty string
    result.isValidSource = true;
    
    // Check if this is a known agent type
    if (KNOWN_AGENT_TYPES.includes(sourceStr.toUpperCase())) {
        result.isAgentSource = true;
        result.agentType = sourceStr.toUpperCase();
        result.confidence = 'high';
        
        elizaLogger.debug(`Identified message source as agent type: ${result.agentType}`);
        return result;
    }
    
    // Check for UUID format
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(sourceStr)) {
        // This is already a UUID, likely a user ID
        result.isUserSource = true;
        result.normalizedId = sourceStr as UUID;
        result.confidence = 'high';
        
        elizaLogger.debug(`Identified message source as UUID: ${result.normalizedId}`);
        return result;
    }
    
    // Check for Discord mention/ID format
    if (sourceStr.match(/^<?@?!?(\d{17,19})>?$/) || sourceStr.match(/^discord-(\d+)$/)) {
        // This looks like a Discord ID, normalize it
        const normalizedId = normalizeUserId(sourceStr);
        if (normalizedId) {
            result.isUserSource = true;
            result.normalizedId = normalizedId;
            result.confidence = 'medium';
            
            elizaLogger.debug(`Normalized Discord ID to UUID: ${result.normalizedId}`);
            return result;
        }
    }
    
    // If we reach here, it's some other string - could be a userId but we're less confident
    // Try to normalize it anyway
    const possibleId = normalizeUserId(sourceStr);
    if (possibleId) {
        result.isUserSource = true;
        result.normalizedId = possibleId;
        result.confidence = 'low';
        
        elizaLogger.debug(`Attempted normalization of unknown source: ${sourceStr} → ${result.normalizedId}`);
        return result;
    }
    
    // If all else fails, mark as invalid source
    elizaLogger.debug(`Unable to identify message source type: ${sourceStr}`);
    return result;
}

/**
 * Extracts user ID from an agent message with improved agent type detection
 * This updated version avoids mistaking agent names for user IDs
 * 
 * @param message - The agent message to extract from
 * @returns A normalized UUID for the user, or ANONYMOUS_USER_ID if no valid user ID found
 */
export function getValidatedUserIdFromMessage(message: AgentMessage): {
    userId: UUID;
    source: string;
    isAgent: boolean;
    agentType?: string;
    confidence: 'high' | 'medium' | 'low' | 'none';
} {
    // Extract source from message, handling optional fields
    const source = message.from || 
                  (message.content && 'userId' in message.content ? message.content.userId : undefined);
    
    const validation = validateMessageSource(source);
    
    // Add explicit debug logging for validation process
    elizaLogger.debug("Validating message source", {
        source,
        isValidSource: validation.isValidSource,
        isUserSource: validation.isUserSource,
        isAgentSource: validation.isAgentSource,
        confidence: validation.confidence,
        messageContent: message.content?.type
    });
    
    if (!validation.isValidSource) {
        elizaLogger.warn("Invalid message source, using anonymous user ID", {
            source,
            messageContent: message.content?.type
        });
        return {
            userId: ANONYMOUS_USER_ID,
            source: "anonymous",
            isAgent: false,
            confidence: 'none'
        };
    }
    
    return {
        userId: validation.normalizedId || ANONYMOUS_USER_ID,
        source: String(source),
        isAgent: validation.isAgentSource,
        agentType: validation.agentType,
        confidence: validation.confidence
    };
}

/**
 * Normalizes a user ID to a consistent UUID format across all agents.
 * This ensures that regardless of the source (Discord ID, UUID, etc.),
 * we always get the same UUID for the same user.
 * 
 * @param userId - The user ID to normalize, which could be in various formats
 * @returns A normalized UUID
 */
export function normalizeUserId(userId: string | undefined): UUID | undefined {
    if (!userId || typeof userId !== 'string') {
        elizaLogger.debug('Invalid userId: missing or not a string', { userId });
        return undefined;
    }
    
    // Enhanced logging to debug ID issues
    elizaLogger.debug("Normalizing user ID", {
        originalValue: userId,
        valueType: typeof userId,
        valueLength: userId.length,
        hasUUID: !!userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    });
    
    // Extract the raw numeric Discord ID from various possible formats
    let rawDiscordId: string = userId;
    
    // Check for UUID format (created by stringToUuid)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(rawDiscordId)) {
        // This is already a UUID, likely from our stringToUuid method
        elizaLogger.debug("ID already in UUID format", { userId: rawDiscordId });
        return rawDiscordId as UUID;
    }
    
    // Extract Discord ID from mention format
    const discordMentionMatch = rawDiscordId.match(/<@!?(\d{17,19})>/);
    if (discordMentionMatch && discordMentionMatch[1]) {
        rawDiscordId = discordMentionMatch[1];
        elizaLogger.debug("Extracted Discord ID from mention format", { rawDiscordId });
    }
    
    // Handle discord- prefix extraction
    if (rawDiscordId.startsWith('discord-')) {
        rawDiscordId = rawDiscordId.substring(8); // Remove 'discord-' prefix
        elizaLogger.debug("Removed discord- prefix", { rawDiscordId });
    }
    
    // Extract numeric ID when wrapped in other formats
    const numericIdMatch = rawDiscordId.match(/(\d{17,19})/);
    if (numericIdMatch && numericIdMatch[1]) {
        rawDiscordId = numericIdMatch[1];
        elizaLogger.debug("Extracted numeric Discord ID", { rawDiscordId });
    }
    
    // CONSISTENCY KEY: Always prefix with discord- and convert to UUID
    const finalId = stringToUuid(`discord-${rawDiscordId}`);
    
    elizaLogger.debug("Final normalized user ID", { 
        originalId: userId,
        extractedRawId: rawDiscordId,
        finalNormalizedId: finalId
    });
    
    return finalId;
}

/**
 * Extracts and normalizes a user ID from an agent message.
 * This handles various sources of user ID in messages.
 * 
 * @param message - The agent message containing user identification
 * @returns A normalized UUID for the user
 * @throws Error if no valid user ID can be extracted
 */
export function getUserIdFromMessage(message: AgentMessage): UUID {
    const validation = getValidatedUserIdFromMessage(message);
    const userId = validation.userId;
    
    // Add explicit debug logging for user ID extraction
    elizaLogger.debug("Extracted user ID from message", { 
        userId: userId.toString(),
        source: validation.source,
        confidence: validation.confidence,
        messageContent: message.content?.type
    });
    
    return userId;
}

/**
 * Finds a user ID from a wallet address by searching wallet registration memories.
 * 
 * @param runtime - The agent runtime
 * @param walletAddress - The wallet address to search for
 * @returns The normalized user ID if found, undefined otherwise
 */
export async function findUserIdByWalletAddress(
    runtime: any,
    walletAddress: string
): Promise<UUID | undefined> {
    try {
        // Normalize wallet address for consistent comparison
        const normalizedWalletAddress = walletAddress.toLowerCase();
        
        // Get wallet registrations from memory - use conversation room ID
        const registrations = await runtime.messageManager.getMemories({
            roomId: CONVERSATION_ROOM_ID,
            count: 1000,
            filter: {
                "content.type": "wallet_registration"
            }
        });
        
        // Enhanced logging for debugging
        elizaLogger.debug("Searching for wallet registrations", {
            walletAddress,
            normalizedWalletAddress,
            registrationsFound: registrations.length,
            statuses: registrations.map(r => r.content.status).filter((v, i, a) => a.indexOf(v) === i),
            roomId: CONVERSATION_ROOM_ID
        });
        
        // Find registration with matching wallet address and valid status ('executed' or 'active')
        const registration = registrations.find(mem => 
            mem.content.type === "wallet_registration" && 
            typeof mem.content.walletAddress === 'string' &&
            mem.content.walletAddress.toLowerCase() === normalizedWalletAddress &&
            (mem.content.status === "executed" || mem.content.status === "active")
        );
        
        if (registration) {
            // Log the found registration for debugging
            elizaLogger.debug("Found wallet registration", {
                walletAddress,
                registrationId: registration.id,
                contentUserId: registration.content.userId,
                memoryUserId: registration.userId,
                roomId: CONVERSATION_ROOM_ID
            });
            
            // Get the user ID from either the memory or the content
            let userId: string | undefined;
            
            // Check content.userId first (most reliable)
            if (registration.content.userId) {
                userId = registration.content.userId as string;
            } 
            // Fallback to memory userId
            else if ('userId' in registration) {
                userId = (registration as any).userId;
            }
            // Last resort: try to extract from discordId if available
            else if (registration.content.discordId && typeof registration.content.discordId === 'string') {
                userId = registration.content.discordId;
            }
            
            // Normalize the user ID
            return normalizeUserId(userId);
        }
        
        return undefined;
    } catch (error) {
        elizaLogger.error("Error finding user ID by wallet address:", error);
        return undefined;
    }
} 