// packages/plugin-solana/src/utils/commandValidation.ts

import { elizaLogger } from "@elizaos/core";
import { PublicKey } from "@solana/web3.js";

// Validates if a string is a valid Solana address
export function isValidSolanaAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
        return false;
    }

    // Simple check for base58 encoding (alphanumeric without 0, O, I, l)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
}

// Validates if a string is a valid Solana transaction signature
export const isValidTransactionSignature = (signature: string): boolean => {
    // Solana transaction signatures are base58 encoded and 88 characters long
    const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]{88}$/;
    return base58Pattern.test(signature);
};

// Validates commands in both direct (!command) and mention (@agent !command) formats
export const validateCommand = (text: string, command: string): boolean => {
    // Match both direct command and Discord mention format
    // This handles:
    // 1. !command
    // 2. <@123456789> !command (Discord mention)
    const commandPattern = new RegExp(`^(?:<@!?\\d+>\\s*)?!${command}(?:\\s|$)`, "i");
    const isValid = commandPattern.test(text);

    elizaLogger.debug(`[Command Validation] Testing command: ${command}`, {
        text,
        pattern: commandPattern.toString(),
        isValid,
        matchResult: text.match(commandPattern),
        mentionMatch: text.match(/^<@!?\d+>/),
        commandPart: text.replace(/^<@!?\d+>\s*/, '').trim()
    });

    return isValid;
};

// Extract a wallet address from any text
export function extractWalletAddress(text: string): string | null {
    if (!text || typeof text !== 'string') {
        return null;
    }
    
    // Look for a valid Solana address format
    const match = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
    return match ? match[1] : null;
}

// For commands that require parameters (like register and verify)
export const validateCommandWithParam = (text: string, command: string, paramPattern: string): RegExpMatchArray | null => {
    // Handle special cases for different commands
    let parameterPattern = paramPattern;
    let additionalValidation = null;

    switch (command) {
        case "register":
            parameterPattern = "[1-9A-HJ-NP-Za-km-z]{32,44}"; // Solana address format
            additionalValidation = isValidSolanaAddress;
            
            // First try the formal command format
            const registerPattern = new RegExp(
                `^(?:(?:<@!?\\d+>|@\\d+)\\s*)?!?${command}\\s+(?:(?:my\\s+)?wallet\\s+)?(${parameterPattern})\\s*$`,
                "i"
            );
            let match = text.match(registerPattern);
            
            // If formal pattern fails, try natural language extraction
            if (!match) {
                const naturalLanguagePattern = new RegExp(
                    `^(?:(?:<@!?\\d+>|@\\w+)\\s*)?(?:please\\s+)?(?:can\\s+you\\s+)?${command}\\s+(?:my|this)\\s+wallet\\s+(?:address\\s+)?([1-9A-HJ-NP-Za-km-z]{32,44})`,
                    "i"
                );
                match = text.match(naturalLanguagePattern);
                
                // If still no match, try to find any valid wallet address in the text
                if (!match && text.toLowerCase().includes("register") && text.toLowerCase().includes("wallet")) {
                    const extractedAddress = extractWalletAddress(text);
                    if (extractedAddress) {
                        // Construct a synthetic match result
                        elizaLogger.debug(`[Register Command] Extracted wallet address using fallback method: ${extractedAddress}`);
                        return [text, extractedAddress];
                    }
                }
            }
            
            return match;
            
        case "verify":
            parameterPattern = "[1-9A-HJ-NP-Za-km-z]{88}"; // Transaction signature format
            additionalValidation = isValidTransactionSignature;
            break;
        default:
            // Use provided pattern for other commands
            break;
    }

    // This handles other commands:
    // 1. !command <param>
    // 2. <@123456789> !command <param> (Discord mention with brackets)
    // 3. @123456789 !command <param> (Discord mention without brackets)
    const commandPattern = new RegExp(
        `^(?:(?:<@!?\\d+>|@\\d+)\\s*)?!?${command}\\s+(${parameterPattern})\\s*$`,
        "i"
    );

    const match = text.match(commandPattern);

    // Additional validation if needed
    if (match && additionalValidation) {
        const param = match[1];
        if (!additionalValidation(param)) {
            elizaLogger.debug(`[Command Validation] Invalid parameter for ${command}: ${param}`);
            return null;
        }
    }

    elizaLogger.debug(`[Command Validation] Testing command with param: ${command}`, {
        text,
        pattern: commandPattern.toString(),
        hasMatch: !!match,
        match: match ? match[1] : null,
        fullMatch: match ? match[0] : null,
        mentionMatch: text.match(/^(?:<@!?\d+>|@\d+)/),
        commandAndParam: text.replace(/^(?:<@!?\d+>|@\d+)\s*/, '').trim(),
        commandType: command,
        parameterPattern,
        validationResult: match && additionalValidation ? additionalValidation(match[1]) : null
    });

    return match;
};

// Helper function to extract command and parameters from text
export function parseCommand(text: string): { command: string; params: string[] } {
    text = text.trim();
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const params = parts.slice(1);
    
    return { command, params };
}

// Add imports if needed
export function validateActionCommand(
    message: any,
    runtime: any,
    actionName: string,
    prefixes: string[], 
    keywords: string[]
): { isValid: boolean; extractedText: string | null } {
    try {
        const messageText = message.content?.text || "";
        
        // Skip empty messages
        if (!messageText.trim()) {
            return { isValid: false, extractedText: null };
        }
        
        // For tokeninfo, apply stricter validation to avoid false positives
        if (actionName === "tokeninfo") {
            // Exclude common conversational patterns that might trigger false positives
            const conversationalPatterns = [
                /^(?:hi|hey|hello|sup|yo|hru|how are you|how r u|good morning|good afternoon|good evening|whats up|what's up|howdy)/i,
                /^(?:thanks|thank you|ty|thx)/i,
                /^(?:nice|cool|awesome|great|good)/i,
                /^(?:hmm|huh|oh|ah|wow|hmm+|oh+)/i,
                /^(?:yes|no|maybe|sure|okay|ok|yep|nope|nah)/i,
                /^(?:lol|haha|lmao|rofl)/i,
                /^(?:can you|could you|would you|do you|are you|will you)/i,
                /^(?:tell me about(?!\s+price|\s+token|\s+volume|\s+liquidity|\s+market))/i,
                /^(?:what do you|who are you|what are you)/i,
                /^(?:i think|i believe|i feel|i want|i need)/i
            ];
            
            // Check if message matches any conversational pattern
            for (const pattern of conversationalPatterns) {
                if (pattern.test(messageText.trim().toLowerCase())) {
                    return { isValid: false, extractedText: null };
                }
            }
            
            // For tokeninfo, validate that the message contains token-related keywords
            const tokenPatterns = [
                /\b(?:price|cost|rate|value)\b.*?\b(?:of|for|on)\b/i,
                /\b(?:volume|liquidity|market\s*cap|mcap|tvl)\b/i,
                /\b(?:sol|btc|eth|usdc|usdt|bonk|jup|ray|msol)\b/i,
                /\b[A-HJ-NP-Za-km-z1-9]{32,44}\b/i // Solana address pattern
            ];
            
            // Require at least one token pattern match for tokeninfo
            const hasTokenPattern = tokenPatterns.some(pattern => pattern.test(messageText));
            if (!hasTokenPattern) {
                return { isValid: false, extractedText: null };
            }
        }
        
        // Continue with normal validation
        const prefixMatched = prefixes.some(prefix => 
            messageText.toLowerCase().includes(prefix.toLowerCase())
        );
        
        const keywordMatched = keywords.some(keyword => 
            messageText.toLowerCase().includes(keyword.toLowerCase())
        );
        
        return {
            isValid: prefixMatched || keywordMatched || message.content?.action === actionName,
            extractedText: messageText
        };
    } catch (error) {
        console.error("Error in validateActionCommand:", error);
        return { isValid: false, extractedText: null };
    }
}