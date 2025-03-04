import { elizaLogger } from "@elizaos/core";
import { AgentMessage } from "./types/base.ts";

/**
 * Safely extracts text from message content, handling alternative formats
 * and performing validation.
 * 
 * @param message The agent message to extract text from
 * @param logPrefix Optional prefix for log messages
 * @returns The extracted text or null if no valid text could be found
 */
export function safeExtractMessageText(message: AgentMessage | null | undefined, logPrefix = ""): string | null {
    if (!message) {
        elizaLogger.warn(`${logPrefix}Cannot extract text from null or undefined message`);
        return null;
    }

    // Log the message structure for debugging
    elizaLogger.debug(`${logPrefix}Message structure:`, {
        hasContent: !!message.content,
        contentType: message.content ? typeof message.content : 'undefined',
        contentKeys: message.content ? Object.keys(message.content).join(', ') : 'none',
        hasText: message.content ? 'text' in message.content : false,
        hasBody: message.content ? 'body' in message.content : false,
        hasMessage: message.content ? 'message' in message.content : false,
        hasRawContent: message.content ? 'rawContent' in message.content : false,
        from: message.from || 'unknown'
    });

    if (!message.content) {
        elizaLogger.warn(`${logPrefix}Message has no content`, {
            from: message.from || 'unknown'
        });
        return null;
    }

    // If text is already present, validate it's a string
    if ('text' in message.content && message.content.text) {
        if (typeof message.content.text !== 'string') {
            elizaLogger.warn(`${logPrefix}Message text is not a string, converting from type: ${typeof message.content.text}`);
            return String(message.content.text);
        }
        return message.content.text;
    }

    // Try alternative formats in order of preference
    const alternativeFields = ['body', 'message', 'rawContent', 'content'];
    
    for (const field of alternativeFields) {
        if (field in message.content && message.content[field]) {
            elizaLogger.info(`${logPrefix}Using alternative message format: ${field}`, {
                fieldType: typeof message.content[field]
            });
            
            const text = message.content[field];
            
            if (!text) {
                continue; // Try next field
            }
            
            if (typeof text !== 'string') {
                elizaLogger.warn(`${logPrefix}Alternative format text (${field}) is not a string, converting from type: ${typeof text}`);
                return String(text);
            }
            
            return text;
        }
    }

    // Check if content itself is a string (some clients might format messages this way)
    if (typeof message.content === 'string' && message.content) {
        elizaLogger.info(`${logPrefix}Content itself is a string, using directly`);
        return message.content;
    }

    // No valid text found
    elizaLogger.warn(`${logPrefix}No text content found in message`, {
        contentKeys: Object.keys(message.content).join(', ')
    });
    return null;
} 