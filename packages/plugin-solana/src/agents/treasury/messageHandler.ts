// messageHandler.ts

import {
  elizaLogger,
  stringToUuid,
  UUID
} from "@elizaos/core";
import { v4 as uuidv4 } from 'uuid';
import { ROOM_IDS } from "../../shared/constants.ts";
import { ANONYMOUS_USER_ID } from "../../shared/fixes/system-user.ts";
import { getValidatedUserIdFromMessage } from "../../shared/utils/userUtils.ts";
import { 
    storeUserMessageWithDeduplication, 
    safeExtractMessageText, 
    getStandardizedRoomId,
    ensureConsistentMemoryIds
} from "../../shared/utils/messageUtils.ts";
import { AgentMessage as ImportedAgentMessage } from "../../shared/types/base.ts";
import { ITreasuryAgent, ValidContentStatus, Memory, IMessageHandler } from "./messageHandlerTypes.ts";
// Import registerHandler for direct access to its functions
import * as registerHandler from "./registerHandler.ts";

// Define the standard conversation room ID
const CONVERSATION_ROOM_ID = ROOM_IDS.DAO;
const defaultRoomId = CONVERSATION_ROOM_ID;

// Helper function to generate UUID in the correct format
function generateUUID(): `${string}-${string}-${string}-${string}-${string}` {
    return uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
}

// Helper function to convert string to UUID format
function toUUID(str: string): `${string}-${string}-${string}-${string}-${string}` {
    return stringToUuid(str) as `${string}-${string}-${string}-${string}-${string}`;
}

// Create message handler class that implements IMessageHandler
export class MessageHandler implements IMessageHandler {
    // ... implement all interface methods ...
    
    public async handleMessage(agent: ITreasuryAgent, message: ImportedAgentMessage): Promise<void> {
        try {
            // First, ensure message has consistent IDs
            if (message && message.content && !message.content.id) {
                // Generate a new ID if needed (safely)
                const messageId = stringToUuid(`msg-${Date.now()}`);
                message.content.id = messageId;
            }
            
            elizaLogger.info("Handling message", { 
                messageId: message.content?.id,
                messageType: message.content?.type,
                from: message.from
            });
            
            // Check for special command messages first
            if (message.content?.type === "verify_command") {
                await this.handleVerifyCommand(agent, message);
                return;
            }
            
            if (message.content?.type === "register_command") {
                await this.handleRegisterCommand(agent, message);
                return;
            }
            
            // If not a special command, treat as general conversation
            await this.handleGeneralConversation(agent, message, agent.getRuntime());
            
            elizaLogger.info("Successfully handled message", { 
                messageId: message.content?.id
            });
        } catch (error) {
            elizaLogger.error("Error handling message:", error);
            try {
                await this.sendErrorMessage(agent);
            } catch (fallbackError) {
                elizaLogger.error("Failed to send error fallback message:", fallbackError);
            } finally {
                elizaLogger.info("Completed error handling attempt");
            }
        }
    }

    public async handleGeneralConversation(
        agent: ITreasuryAgent,
        message: ImportedAgentMessage,
        runtime: any
    ): Promise<void> {
        try {
            // Ensure the message content ID is preserved
            // This is critical for the "isCurrent" check when building conversation context
            if (message && message.content && !message.content.id) {
                // Generate a consistent UUID for this message if not already present
                const messageId = stringToUuid(`msg-${Date.now()}`);
                message.content.id = messageId;
            }
            
            // Save the user message to database with the same ID for both message and content
            await storeUserMessageWithDeduplication(
                message, 
                agent.getRuntime().messageManager,
                defaultRoomId
            );
            
            // Get validated user ID
            const userId = getValidatedUserIdFromMessage(message).userId;
            
            // Retrieve recent memories including the message we just stored
            const memories = await this.retrieveRelevantMemories(
                agent,
                message,
                defaultRoomId,
                userId
            );
            
            // Build conversation context with proper ID handling
            const conversationContext = await this.buildConversationContext(
                agent,
                message,
                memories
            );
            
            // Process the conversation with the AI model
            const responseText = await this.processConversationWithModel(
                agent,
                conversationContext
            );
            
            // Send the response back to the user
            await this.sendMessageToClients(
                agent,
                defaultRoomId,
                responseText
            );
            
            elizaLogger.info("Successfully handled general conversation", {
                userId,
                messageId: message.content.id
            });
        } catch (error) {
            elizaLogger.error("Error in handleGeneralConversation:", error);
            try {
                await this.sendErrorMessage(agent);
            } catch (finalError) {
                elizaLogger.error("Failed to send error message:", finalError);
            } finally {
                elizaLogger.info("Completed error handling attempt");
            }
        }
    }

    public async handleVerifyCommand(agent: ITreasuryAgent, message: ImportedAgentMessage): Promise<void> {
        try {
            elizaLogger.info("Handling verify command", { 
                userId: message.from, 
                messageId: message.content.id 
            });
            
            await agent.handleVerification(message);
            
            elizaLogger.info("Successfully handled verify command", { 
                userId: message.from, 
                messageId: message.content.id 
            });
        } catch (error) {
            elizaLogger.error("Error handling verify command:", error);
            if (error instanceof Error) {
                elizaLogger.error("Error details:", {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                });
            }
            await this.sendErrorMessage(agent);
        }
    }

    public async handleRegisterCommand(agent: ITreasuryAgent, message: ImportedAgentMessage): Promise<void> {
        try {
            elizaLogger.info("Handling register command", { 
                userId: message.from, 
                messageId: message.content.id 
            });
            
            // Call the agent's handler which returns a response
            await registerHandler.handleRegisterCommand(agent, message, async (response) => {
                if (response) {
                    // Extract the original channel ID from message metadata
                    const realChannelId = message.content.metadata?.originalChannelId as string | undefined;
                    elizaLogger.info("Sending registration response", {
                        channelId: realChannelId || ROOM_IDS.DAO,
                        responseStatus: response.status,
                        responseId: response.id
                    });

                    // Send direct message to the client using the real channel ID if available
                    await this.sendMessageToClients(
                        agent,
                        realChannelId || ROOM_IDS.DAO,
                        response.text
                    );
                    elizaLogger.info("Sent registration response to client", {
                        status: response.status,
                        responseId: response.id
                    });
                }
            });
            
            elizaLogger.info("Successfully handled register command", { 
                userId: message.from, 
                messageId: message.content.id 
            });
        } catch (error) {
            elizaLogger.error("Error handling register command:", error);
            if (error instanceof Error) {
                elizaLogger.error("Error details:", {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                });
            }
            await this.sendErrorMessage(agent);
        }
    }

    public async retrieveRelevantMemories(
        agent: ITreasuryAgent,
        message: ImportedAgentMessage,
        roomId: string,
        userId: string
    ): Promise<Memory[]> {
        try {
            const runtime = agent.getRuntime();
            const standardRoomId = getStandardizedRoomId(roomId);
            
            if (!runtime.messageManager) {
                elizaLogger.error("Message manager not available");
                return [];
            }
            
            const memories = await runtime.messageManager.getMemoriesByRoomIds({
                roomIds: [standardRoomId],
                limit: 20
            });
            
            // Filter and ensure consistent memory IDs
            return memories
                .filter(memory => {
                    if (!memory.content) return false;
                    return memory.userId === userId || memory.content.agentId === agent.getAgentId();
                })
                .map(memory => ensureConsistentMemoryIds(memory));
        } catch (error) {
            elizaLogger.error("Error retrieving relevant memories:", error);
            return [];
        }
    }

    public async sendMessageToClients(agent: ITreasuryAgent, roomId: string, text: string): Promise<void> {
        const runtime = agent.getRuntime();
        
        // Try to send the message via Discord if available
        if (runtime.clients?.Discord) {
            try {
                await runtime.clients.Discord.sendMessage({
                    content: text,
                    roomId: toUUID(roomId)
                });
                elizaLogger.info("Sent response via Discord client");
                return;
            } catch (discordError) {
                elizaLogger.error("Error sending message via Discord:", discordError);
            }
        }
        
        // If Discord fails or isn't available, try Direct client
        if (runtime.clients?.Direct) {
            try {
                await runtime.clients.Direct.sendMessage({
                    content: text,
                    roomId: toUUID(roomId)
                });
                elizaLogger.info("Sent response via Direct client");
                return;
            } catch (directError) {
                elizaLogger.error("Error sending message via Direct client:", directError);
            }
        }
        
        // Last resort: try to use agent's sendMessage method
        try {
            await agent.sendMessage({
                content: {
                    text: text,
                    type: "agent_response",
                    id: generateUUID(),
                    status: "completed" as ValidContentStatus,
                    agentId: agent.getAgentId(),
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                },
                from: agent.getAgentType(),
                to: "USER",
                global: true
            });
            elizaLogger.info("Sent response via agent's sendMessage method");
        } catch (sendError) {
            elizaLogger.error("Failed to send response through any available method:", sendError);
            throw sendError;
        }
    }

    private async sendErrorMessage(agent: ITreasuryAgent): Promise<void> {
        const errorMessage = "I encountered an error processing your message. Could you try rephrasing or let me know what you'd like to discuss?";
        const errorId = generateUUID();
        
        try {
            elizaLogger.info("Sending error message to user", { errorId });
            
            await agent.sendMessage({
                type: "error_response",
                content: {
                    id: errorId,
                    text: errorMessage,
                    status: "rejected" as ValidContentStatus,
                    agentId: agent.getAgentId(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    action: "conversation"
                },
                from: agent.getAgentType(),
                to: "ALL"
            });
            
            elizaLogger.info("Successfully sent error message", { errorId });
        } catch (error) {
            elizaLogger.error("Failed to send error message:", error);
            if (error instanceof Error) {
                elizaLogger.error("Error details:", {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                });
            }
        }
    }

    /**
     * Builds the conversation context with proper handling of the current message
     * This fixes the one-turn lag issue by correctly identifying the latest message
     */
    private async buildConversationContext(
        agent: ITreasuryAgent,
        currentMessage: ImportedAgentMessage,
        memories: Memory[]
    ): Promise<string> {
        try {
            if (!memories.length) {
                return `User: ${currentMessage.content.text}\n\n# INSTRUCTIONS: Respond to the user's message.`;
            }
            
            // Create conversation array for context building
            const conversationArray: string[] = [];
            
            // Add each memory to conversation context
            memories.forEach(memory => {
                // Ensure consistent memory IDs first - using any to bridge type compatibility
                const memoryWithConsistentIds = ensureConsistentMemoryIds(memory as any) as Memory;
                
                // Add label based on who sent the message
                const isAgent = memoryWithConsistentIds.content?.agentId === agent.getAgentId();
                const prefix = isAgent ? 'Vela: ' : 'User: ';
                
                // Get message text
                const text = memoryWithConsistentIds.content?.text || '';
                
                // CRITICAL FIX: Check if this is the current message using identical IDs
                // This is where the one-turn lag issue occurs if IDs don't match
                const isCurrent = 
                    (memoryWithConsistentIds.id === currentMessage.content.id) || 
                    (memoryWithConsistentIds.content?.id === currentMessage.content.id);
                
                elizaLogger.debug("Memory ID comparison:", {
                    memoryId: memoryWithConsistentIds.id,
                    memoryContentId: memoryWithConsistentIds.content?.id,
                    currentMessageId: currentMessage.content.id,
                    isCurrent
                });
                
                // Add message to conversation array
                conversationArray.push(`${prefix}${text}`);
                
                // If this is the current message, add the INSTRUCTIONS marker
                // This ensures the agent only responds to the latest message
                if (isCurrent) {
                    conversationArray.push(`# INSTRUCTIONS: Respond to the user's message above.`);
                }
            });
            
            // If no current message was found in memories, add it explicitly
            const currentFound = memories.some(memory => 
                memory.id === currentMessage.content.id || 
                memory.content?.id === currentMessage.content.id
            );
            
            if (!currentFound) {
                elizaLogger.warn("Current message not found in memories, adding explicitly");
                conversationArray.push(`User: ${currentMessage.content.text}`);
                conversationArray.push(`# INSTRUCTIONS: Respond to the user's message above.`);
            }
            
            // Join all lines with double newlines for clear formatting
            return conversationArray.join('\n\n');
        } catch (error) {
            elizaLogger.error("Error building conversation context:", error);
            // Fallback to a simple context if there's an error
            return `User: ${currentMessage.content.text}\n\n# INSTRUCTIONS: Respond to the user's message.`;
        }
    }
    
    /**
     * Processes the conversation context with the AI model
     */
    private async processConversationWithModel(
        agent: ITreasuryAgent,
        conversationContext: string
    ): Promise<string> {
        try {
            const runtime = agent.getRuntime();
            
            // Call the AI model to generate a response
            const response = await runtime.chat.sendMessage({
                text: conversationContext,
                role: 'user'
            });
            
            if (!response || !response.text) {
                throw new Error("Empty response from model");
            }
            
            return response.text;
        } catch (error) {
            elizaLogger.error("Error processing with model:", error);
            return "I'm having trouble processing your request. Could you try again?";
        }
    }
}

// Create and export singleton instance
export const messageHandler = new MessageHandler(); 