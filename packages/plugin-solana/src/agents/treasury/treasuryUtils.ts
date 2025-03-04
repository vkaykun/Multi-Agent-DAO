// Treasury Agent Utilities
// Contains reusable functions and utilities for the Treasury Agent

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
  Content,
  composeContext,
  generateObject,
  ModelClass,
} from "@elizaos/core";
import {
  BaseContent,
  AgentMessage,
  ContentStatus,
} from "../../shared/types/base.ts";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { ExtendedAgentRuntime } from "../../shared/utils/runtime.ts";
import { getUserIdFromMessage } from "../../shared/utils/userUtils.ts";
import { ROOM_IDS } from "../../shared/constants.ts";

/**
 * Validates if an address is a valid Solana address by checking if it's on the ed25519 curve
 */
export async function validateSolanaAddress(address: string): Promise<boolean> {
  try {
    const pubKey = new PublicKey(address);
    return PublicKey.isOnCurve(pubKey);
  } catch (error) {
    elizaLogger.debug(`Invalid Solana address format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

/**
 * Checks wallet balance for a given connection and public key
 */
export async function checkWalletBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
  try {
    const balance = await connection.getBalance(publicKey);
    return balance / 1_000_000_000; // Convert from lamports to SOL
  } catch (error) {
    elizaLogger.error("Error checking wallet balance:", error);
    return 0;
  }
}

/**
 * Parses a register command from a message text
 */
export function parseRegisterCommand(message: AgentMessage): { walletAddress: string | null } {
  const text = (message.content.text || "").trim();

  // Check for direct command format "!register <address>"
  const registerMatch = text.match(/^!register\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (registerMatch && registerMatch[1]) {
    return { walletAddress: registerMatch[1] };
  }

  // Check for Discord mention format "@vela register <address>"
  // Updated to match Discord's actual mention format: <@123456789012345678>
  const discordMentionMatch = text.match(/<@!?\d+>\s+(?:register|connect|add|link|set up)(?:\s+(?:my|this|a))?\s*(?:wallet|address|account)?\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (discordMentionMatch && discordMentionMatch[1]) {
    return { walletAddress: discordMentionMatch[1] };
  }

  // Check for natural language format with various phrasings
  // Enhanced to capture more natural language patterns
  // This covers patterns like:
  // - "register my wallet <address>"
  // - "I want to register wallet <address>"
  // - "connect wallet <address>"
  // - "add my address <address>"
  // - "link this wallet <address>"
  // - "I'd like to register <address>"
  // - "please register <address> as my wallet"
  const nlMatch = text.match(/(?:(?:I(?:'d| would) like to|I want to|please|can you|could you)?\s+)?(?:register|connect|add|link|set up)(?:\s+(?:my|this|a))?\s*(?:wallet|address|account)?(?:\s+(?:as|with|to|for|using))?\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (nlMatch && nlMatch[1]) {
    return { walletAddress: nlMatch[1] };
  }

  // Check for patterns where the address comes first
  // Example: "<address> is my wallet address, please register it"
  const addressFirstMatch = text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(?:is|as|for|to))?\s+(?:my|this|the)?\s*(?:wallet|address|account)(?:\s+(?:to register|to connect|to add|to link|for registration))?/i);
  if (addressFirstMatch && addressFirstMatch[1]) {
    return { walletAddress: addressFirstMatch[1] };
  }

  // Fallback to just finding a valid Solana address in a message with registration intent
  if (/\b(?:register|connect|add|link|set up)\b.*?\b(?:wallet|address|account)\b/i.test(text)) {
    const addressMatch = text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (addressMatch && addressMatch[1]) {
      return { walletAddress: addressMatch[1] };
    }
  }

  return { walletAddress: null };
}

/**
 * Validates a token address format
 */
export function validateTokenAddress(address: string | null): boolean {
  if (!address) return false;
  
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Extracts token addresses from message text
 */
export function extractTokenAddresses(text: string): { input: string | null; output: string | null } {
  // Simple regex to extract Solana addresses
  const addressMatches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  
  if (!addressMatches) {
    return { input: null, output: null };
  }
  
  // If we have at least one address
  if (addressMatches.length === 1) {
    // If only one address found, determine if it's input or output based on context
    if (text.toLowerCase().includes("swap from") || text.toLowerCase().includes("input")) {
      return { input: addressMatches[0], output: null };
    } else if (text.toLowerCase().includes("swap to") || text.toLowerCase().includes("output")) {
      return { input: null, output: addressMatches[0] };
    }
  }
  
  // If we have at least two addresses
  if (addressMatches.length >= 2) {
    return { input: addressMatches[0], output: addressMatches[1] };
  }
  
  return { input: null, output: null };
}

/**
 * Detects SOL token in text
 */
export function detectSOLToken(text: string, position: "input" | "output"): boolean {
  const solVariations = ["SOL", "sol ", "solana", "native"];
  const inputPhrases = ["from", "input", "sell", "source"];
  const outputPhrases = ["to", "output", "buy", "target"];
  
  // Determine which set of phrases to use based on position
  const phrases = position === "input" ? inputPhrases : outputPhrases;
  
  // Check for phrases like "swap from SOL" or "swap to SOL"
  for (const phrase of phrases) {
    for (const sol of solVariations) {
      if (text.toLowerCase().includes(`${phrase} ${sol.toLowerCase()}`)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Parse user amount from text
 */
export function parseUserAmount(text: string): number | null {
  const amountMatch = text.match(/(?:swap|transfer|send|amount|quantity|for)\s+(\d+(?:\.\d+)?)/i);
  if (amountMatch && amountMatch[1]) {
    return parseFloat(amountMatch[1]);
  }
  return null;
}

/**
 * Format error for logging
 */
export function formatErrorLog(error: unknown): { error: string; [key: string]: unknown } {
  if (error instanceof Error) {
    return {
      error: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  
  return {
    error: String(error),
  };
}

/**
 * Create a response for a registration command
 */
export function createRegistrationResponse(
  text: string,
  status: ContentStatus,
  message: AgentMessage,
  additionalMetadata: Record<string, any> = {}
): Content {
  return {
    type: "register_response",
    id: stringToUuid(`register-response-${Date.now()}`),
    text,
    status,
    agentId: message.to,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      userId: getUserIdFromMessage(message),
      originalMessageId: message.content.id,
      ...additionalMetadata
    }
  };
}

/**
 * Interpret a message to determine its intent
 */
export async function interpretMessage(
  runtime: ExtendedAgentRuntime,
  message: AgentMessage,
  treasuryInterpretTemplate: string
): Promise<{ confidence: number; actionType: string; walletAddress?: string; transactionSignature?: string }> {
  const text = message.content.text || "";

  // Check for greeting messages with mentions first - to avoid false positives
  const simpleGreetingWithMentionRegex = /^(?:hi|hey|hello|howdy|greetings|sup|yo|heya|hi there|hey there)(?:\s+@?\w+|\s+<@!?\d+>)/i;
  if (simpleGreetingWithMentionRegex.test(text)) {
    elizaLogger.debug("Detected greeting with mention, categorizing as unknown", { text });
    return {
      confidence: 0.3,
      actionType: "unknown"
    };
  }
  
  // SKIP ALL REGISTRATION LOGIC IF NO EXPLICIT REGISTRATION KEYWORDS
  // Check for explicit registration keywords FIRST - before even considering mentions
  const hasRegistrationKeyword = /\b(?:register|connect|add|link)\b/i.test(text);
  const hasWalletOrAddress = /\b(?:wallet|address)\b/i.test(text);
  
  // Only proceed with registration checks if BOTH conditions are met
  if (hasRegistrationKeyword && hasWalletOrAddress) {
    // Now check for mentions with registration intent
    const discordMentionRegex = /<@!?\d+>|@\w+/;
    
    // Extract wallet address directly from message
    const parsedCommand = parseRegisterCommand(message);
    
    if (parsedCommand.walletAddress) {
      elizaLogger.debug("Extracted wallet address from registration message", {
        text,
        walletAddress: parsedCommand.walletAddress,
        hasMention: discordMentionRegex.test(text)
      });
      
      return {
        confidence: 0.95,
        actionType: "register",
        walletAddress: parsedCommand.walletAddress
      };
    }
  }
  
  // Continue with regular LLM-based interpretation for other cases
  const context = composeContext({
    state: {
      message: text,
      bio: "",
      lore: "",
      messageDirections: "{}",
      postDirections: "{}",
      roomId: ROOM_IDS.DAO,
      actors: "[]",
      recentMessages: "[]",
      recentMessagesData: []
    },
    template: treasuryInterpretTemplate
  });

  const result = await generateObject({
    runtime,
    context,
    modelClass: ModelClass.SMALL
  });

  const interpretation = result as unknown as { confidence: number; actionType: string; walletAddress?: string; transactionSignature?: string };
  
  // Extra safety check: don't let LLM return "register" without explicit keywords
  if (interpretation.actionType === "register" && !(hasRegistrationKeyword && hasWalletOrAddress)) {
    elizaLogger.debug("LLM returned register but no registration keywords found - overriding to unknown", {
      text,
      interpretedAction: interpretation.actionType,
      hasRegistrationKeyword,
      hasWalletOrAddress
    });
    
    interpretation.actionType = "unknown";
    interpretation.confidence = 0.3;
    return interpretation;
  }
  
  // If LLM set action to register and didn't extract wallet address, try regex
  if (interpretation.actionType === "register" && !interpretation.walletAddress) {
    const parsedCommand = parseRegisterCommand(message);
    
    if (parsedCommand.walletAddress) {
      elizaLogger.debug("Fallback wallet address extraction after LLM interpretation", {
        text,
        walletAddress: parsedCommand.walletAddress
      });
      
      interpretation.walletAddress = parsedCommand.walletAddress;
      interpretation.confidence = Math.max(interpretation.confidence, 0.85);
    }
  }

  return interpretation;
} 