// messageHandlerTypes.ts

import { UUID } from "@elizaos/core";
import { AgentMessage, BaseContent } from "../../shared/types/base.ts";

// Define valid content status types
export type ValidContentStatus = "cancelled" | "draft" | "open" | "pending_execution" | "executing" | "executed" | "rejected" | "failed";

// Define minimal interface for treasury agent functionality
export interface ITreasuryAgent {
    getRuntime(): any;
    getAgentId(): string;
    getAgentType(): string;
    sendMessage(message: any): Promise<void>;
    handleDepositInstructions(message: any): Promise<void>;
    handleBalanceCommand(message: any): Promise<void>;
    handleVerification(message: any): Promise<void>;
    handleRegisterCommand(message: any): Promise<void>;
}

// Define memory interface
export interface Memory {
    id?: string;
    userId?: string;
    roomId?: string;
    content?: {
        text?: string;
        type?: string;
        createdAt?: number;
        [key: string]: any;
    };
    [key: string]: any;
}

// Define message handler interface
export interface IMessageHandler {
    handleMessage(agent: ITreasuryAgent, message: AgentMessage): Promise<void>;
    handleGeneralConversation(agent: ITreasuryAgent, message: AgentMessage, runtime: any): Promise<void>;
    handleVerifyCommand(agent: ITreasuryAgent, message: AgentMessage): Promise<void>;
    handleRegisterCommand(agent: ITreasuryAgent, message: AgentMessage): Promise<void>;
    sendMessageToClients(agent: ITreasuryAgent, roomId: string, text: string): Promise<void>;
    retrieveRelevantMemories(agent: ITreasuryAgent, message: AgentMessage, roomId: string, userId: string): Promise<Memory[]>;
} 