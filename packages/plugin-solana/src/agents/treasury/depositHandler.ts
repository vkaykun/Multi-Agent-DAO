// Treasury Agent Deposit Handler
// Contains logic for handling deposits and deposit verifications

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
import {
  DepositContent,
  PendingDeposit,
} from "../../shared/types/treasury.ts";
import { verifyAndRecordDeposit } from "../../utils/depositUtils.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import { TreasuryAgent } from "./TreasuryAgent.ts";

/**
 * Handle deposit instructions request
 */
export async function handleDepositInstructions(agent: TreasuryAgent, message: AgentMessage): Promise<void> {
  try {
    // Get the wallet address for the treasury
    const treasuryAddress = agent.getTreasuryAddress();
    if (!treasuryAddress) {
      throw new Error("Treasury wallet address not available");
    }

    // Create detailed deposit instructions
    const instructionsText = `
# Deposit Instructions

To deposit funds to the DAO treasury, send tokens to the following Solana address:

\`\`\`
${treasuryAddress}
\`\`\`

## Important Notes:
- Only send SOL or SPL tokens to this address
- Once you've made the deposit, verify it with: \`!verify <transaction_signature>\`

## Example:
\`!verify 4gp7zsGsiEJXxXzJ6PvhSdFDQQzfCyfhsJVvy7ndYjvGNYg4ZGsvZmNKTGQEijXCjF7kUbJX9mtKMAoQZWyU9i3a\`

Need help? Just ask!
`;

    // Send the deposit instructions
    await agent.sendMessage({
      type: "deposit_instructions",
      content: {
        type: "deposit_instructions",
        id: stringToUuid(`deposit-instructions-${Date.now()}`),
        text: instructionsText,
        status: "executed" as ContentStatus,
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          treasuryAddress,
          userId: message.from
        }
      },
      from: agent.getAgentType(),
      to: "ALL"
    });
  } catch (error) {
    elizaLogger.error("Error in deposit instructions handler:", error);

    // Send error response
    await agent.sendMessage({
      type: "error_response",
      content: {
        type: "error_response",
        id: stringToUuid(`error-${Date.now()}`),
        text: `Error providing deposit instructions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status: "failed" as ContentStatus,
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      from: agent.getAgentType(),
      to: "ALL"
    });
  }
}

/**
 * Handle deposit received event
 */
export async function handleDeposit(agent: TreasuryAgent, content: DepositContent): Promise<void> {
  // This method now only handles deposit_received events from other parts of the system
  if (content.type !== "deposit_received") {
    return;
  }

  try {
    // Store the pending deposit without verification
    await agent.createMemoryPublic({
      type: "pending_deposit",
      id: stringToUuid(`deposit-${content.txSignature}`),
      text: `Received deposit notification for transaction ${content.txSignature}`,
      status: "pending_execution" as ContentStatus, // Changed from pending_verification
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        txSignature: content.txSignature,
        userId: content.userId,
        timestamp: Date.now(),
        requiresVerification: true // Added flag to indicate verification needed
      }
    });

    // Send response asking for verification
    await agent.sendMessage({
      type: "deposit_response",
      content: {
        type: "deposit_response",
        id: stringToUuid(`deposit-response-${content.txSignature}`),
        text: `Deposit notification received. Please verify your deposit using:\n!verify ${content.txSignature}`,
        status: "pending_execution" as ContentStatus, // Changed from pending_verification
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      from: agent.getAgentType(),
      to: "ALL"
    });
  } catch (error) {
    elizaLogger.error("Error handling deposit received:", error);
    
    // Send error response
    await agent.sendMessage({
      type: "error_response",
      content: {
        type: "error_response",
        id: stringToUuid(`error-${Date.now()}`),
        text: `Error processing deposit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status: "failed" as ContentStatus,
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      from: agent.getAgentType(),
      to: "ALL"
    });
  }
}

/**
 * Handle verification of a deposit
 */
export async function handleVerification(agent: TreasuryAgent, content: DepositContent | AgentMessage): Promise<void> {
  try {
    let txSignature: string;
    
    // Extract transaction signature based on content type
    if ('type' in content && content.type === 'deposit_content' && 'txSignature' in content) {
      txSignature = content.txSignature as string;
    } else if ('content' in content && content.content && typeof content.content === 'object' && 'text' in content.content) {
      // Extract from message text
      const text = content.content.text as string;
      const match = text.match(/!verify\s+([1-9A-HJ-NP-Za-km-z]{88})/i);
      if (!match || !match[1]) {
        await agent.sendMessage({
          type: "verify_response",
          content: {
            type: "verify_response",
            id: stringToUuid(`verify-error-${Date.now()}`),
            text: "Please provide a valid transaction signature with the verify command. Example: !verify 4gp7zsGsiEJXxXzJ6PvhSdFDQQzfCyfhsJVvy7ndYjvGNYg4ZGsvZmNKTGQEijXCjF7kUbJX9mtKMAoQZWyU9i3a",
            status: "failed" as ContentStatus,
            agentId: agent.getAgentId(),
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          from: agent.getAgentType(),
          to: "ALL"
        });
        return;
      }
      txSignature = match[1];
    } else {
      throw new Error("Invalid content for verification");
    }

    // Get connection from agent
    const connection = agent.getConnection();
    if (!connection) {
      throw new Error("Solana connection not available");
    }

    // Get user ID
    const userId = 'content' in content && content.from ? 
      content.from : 
      ('userId' in content ? content.userId : undefined);

    if (!userId) {
      throw new Error("Could not determine user ID for verification");
    }

    // Call the actual verifyAndRecordDeposit function from depositUtils
    const verificationResult = await verifyAndRecordDeposit(txSignature, agent.getRuntime());
    
    if (!verificationResult) {
      throw new Error("Verification failed: Could not find transaction");
    }

    // Send verification success response
    await agent.sendMessage({
      type: "verify_response",
      content: {
        type: "verify_response",
        id: stringToUuid(`verify-success-${txSignature}`),
        text: `✅ Deposit successfully verified!\n\nToken: SOL\nAmount: ${verificationResult.amountSOL}\nTimestamp: ${new Date().toLocaleString()}\n\nThank you for your contribution to the treasury!`,
        status: "executed" as ContentStatus,
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          txSignature,
          token: "SOL", // Assuming SOL for now
          amount: verificationResult.amountSOL.toString(),
          timestamp: Date.now()
        }
      },
      from: agent.getAgentType(),
      to: "ALL"
    });

    // Update pending deposit to verified
    const pendingDepositId = stringToUuid(`deposit-${txSignature}`);
    
    try {
      // Get existing deposit memory if it exists
      const deposits = await agent.getRuntime().messageManager.getMemories({
        roomId: ROOM_IDS.DAO,
        count: 1
      });

      // Find the matching deposit
      const pendingDeposit = deposits.find(mem => mem.id === pendingDepositId);

      if (pendingDeposit && pendingDeposit.content) {
        // Create verified deposit memory
        await agent.createMemoryPublic({
          type: "deposit_verified",
          id: stringToUuid(`verified-deposit-${txSignature}`),
          text: `Deposit verified for transaction ${txSignature}`,
          status: "executed" as ContentStatus,
          agentId: agent.getAgentId(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          fromAddress: verificationResult.fromAddress,
          amount: verificationResult.amountSOL.toString(),
          token: "SOL", // Assuming SOL for now
          metadata: {
            txSignature,
            verified: true,
            verifiedAt: Date.now(),
            pendingDepositId: pendingDeposit.id
          }
        });
      }
    } catch (error) {
      elizaLogger.warn(`Error updating pending deposit status: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Continue since verification already succeeded
    }

    // Create transaction record in the treasury
    await agent.createMemoryPublic({
      type: "treasury_transaction",
      id: stringToUuid(`tx-${txSignature}`),
      text: `Treasury deposit: ${verificationResult.amountSOL} SOL`,
      status: "executed" as ContentStatus,
      agentId: agent.getAgentId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        txSignature,
        token: "SOL", // Assuming SOL for now
        amount: verificationResult.amountSOL.toString(),
        timestamp: Date.now(),
        transactionType: "deposit",
        senderAddress: verificationResult.fromAddress
      }
    });
  } catch (error) {
    elizaLogger.error("Error in verification handler:", error);
    
    // Send error response
    await agent.sendMessage({
      type: "verify_response",
      content: {
        type: "verify_response",
        id: stringToUuid(`verify-error-${Date.now()}`),
        text: `Error verifying deposit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status: "failed" as ContentStatus,
        agentId: agent.getAgentId(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      from: agent.getAgentType(),
      to: "ALL"
    });
  }
}

/**
 * Get pending deposit by transaction signature
 */
export async function getPendingDeposit(agent: TreasuryAgent, txSignature: string): Promise<PendingDeposit | null> {
  try {
    // Query all deposits and filter manually
    const deposits = await agent.getRuntime().messageManager.getMemories({
      roomId: ROOM_IDS.DAO,
      count: 100
    });

    // Find the matching deposit with the given txSignature
    const pendingDeposit = deposits.find(mem => {
      if (!mem.content) return false;

      // Type-safe check for content properties
      const content = mem.content;
      if (typeof content !== 'object') return false;
      
      // Check if this is a pending deposit with matching signature
      const isRightType = content.type === "pending_deposit";
      
      // Safely check metadata if it exists
      const metadata = content.metadata;
      const hasMatchingSignature = metadata && 
        typeof metadata === 'object' && 
        'txSignature' in metadata && 
        metadata.txSignature === txSignature;
        
      return isRightType && hasMatchingSignature;
    });

    if (!pendingDeposit) {
      return null;
    }

    return pendingDeposit.content as PendingDeposit;
  } catch (error) {
    elizaLogger.error("Error fetching pending deposit:", error);
    return null;
  }
} 