// Treasury Agent Transfer Handler
// Contains logic for handling token transfers

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
} from "@elizaos/core";
import {
  BaseContent,
  AgentMessage,
  ContentStatus,
} from "../../shared/types/base.ts";
import { TransferContent } from "../../shared/types/treasury.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { getWalletKey } from "../../keypairUtils.ts";
import { TransferState } from "./types/handlerTypes.ts";
import { TreasuryAgent } from "./TreasuryAgent.ts";

/**
 * Type guard to check if content is TransferContent
 */
function isTransferContent(content: any): content is TransferContent {
  return content && 
    typeof content === 'object' && 
    'type' in content && 
    content.type === 'transfer_requested';
}

/**
 * Handles a transfer request from a user or another agent
 */
export async function handleTransfer(agent: TreasuryAgent, content: TransferContent | Memory): Promise<void> {
  const memoryManager = agent.getRuntime().messageManager;
  
  try {
    // Safely log debug information
    const contentId = 'id' in content ? content.id : undefined;
    const userId = 'userId' in content ? content.userId : undefined;
    const contentType = isTransferContent(content) ? content.type : 
      ('content' in content && content.content && typeof content.content === 'object' && 'type' in content.content) 
        ? String(content.content.type) 
        : 'unknown';
        
    elizaLogger.debug('[TRANSFER handler] Starting transfer with message:', {
      messageId: contentId,
      userId,
      contentType
    });

    // Skip if already processed
    const state = content as unknown as TransferState;
    if (state.lastProcessedMessageId === ('id' in content ? content.id : undefined)) {
      elizaLogger.debug('[TRANSFER handler] Skipping already processed message');
      return;
    }

    // Get wallet key first to determine the lock key
    const { keypair: senderKeypair } = await getWalletKey(agent.getRuntime(), true);
    if (!senderKeypair) {
      await agent.sendMessage({
        type: "transfer_response",
        content: {
          type: "transfer_response",
          id: stringToUuid(`transfer-error-${Date.now()}`),
          text: "Failed to get wallet keypair",
          status: "failed",
          agentId: agent.getAgentId(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        },
        from: agent.getAgentType(),
        to: "ALL"
      });
      return;
    }

    // Acquire lock for treasury SOL transfers
    const lock = await agent.acquireDistributedLock('treasury-sol-transfer');
    if (!lock) {
      throw new Error("Could not acquire treasury lock");
    }

    try {
      // Create a transaction wrapper using try-catch without directly calling withTransaction
      try {
        // Parse the transfer details directly from the message
        if (!content.content || 
            typeof content.content !== 'object' || 
            !('text' in content.content) || 
            typeof content.content.text !== 'string') {
          return;
        }

        const text = content.content.text.trim();
        const transferRegex = /^(?:<@\d+>\s+)?(?:transfer|send)\s+(\d*\.?\d+)\s*(?:SOL|sol)\s+(?:to\s+)?([A-HJ-NP-Za-km-z1-9]{32,44})$/i;
        const match = text.match(transferRegex);

        if (!match) {
          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-error-${Date.now()}`),
              text: "Invalid transfer format. Please use: transfer <amount> SOL to <address>",
              status: "failed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });
          return;
        }

        const amount = parseFloat(match[1]);
        if (isNaN(amount) || amount <= 0) {
          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-error-${Date.now()}`),
              text: "Invalid amount: Amount must be greater than 0",
              status: "failed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });
          return;
        }

        const recipient = match[2];

        // Validate recipient address format
        try {
          new PublicKey(recipient);
        } catch (err) {
          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-error-${Date.now()}`),
              text: "Invalid recipient address format",
              status: "failed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });
          return;
        }

        elizaLogger.debug('[TRANSFER handler] Connecting to Solana...');
        const connection = agent.getConnection();
        if (!connection) {
          throw new Error("Solana connection not available");
        }

        // Check balance
        elizaLogger.debug('[TRANSFER handler] Checking balance...');
        const currentBalance = await checkWalletBalance(connection, senderKeypair.publicKey);
        elizaLogger.debug(`[TRANSFER handler] Current balance: ${currentBalance} SOL`);

        if (amount >= currentBalance) {
          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-error-${Date.now()}`),
              text: `Insufficient balance. You have ${currentBalance} SOL but tried to send ${amount} SOL.`,
              status: "failed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });
          return;
        }

        try {
          elizaLogger.debug("[TRANSFER handler] Executing SOL transfer...");
          const signature = await handleSolTransfer(
            agent,
            connection,
            recipient,
            amount
          );

          elizaLogger.info("Transfer successful, signature:", signature);
          const explorerUrl = `https://explorer.solana.com/tx/${signature}`;

          // Look up if this is a transfer to a registered wallet
          const registeredWallets = await memoryManager.getMemories({
            roomId: agent.getAgentId(),
            count: 1000
          });

          // Find if recipient matches any registered wallet
          const registeredUser = registeredWallets.find(mem =>
            mem.content.type === "registered_wallet" &&
            mem.content.publicKey === recipient
          );

          // Generate unique memory ID for transfer record
          const memoryId = stringToUuid(`${'userId' in content ? content.userId : 'content'}-transfer-${signature}-${Date.now()}`);

          // Store transfer record in memory with registered user info if found
          await memoryManager.createMemory({
            id: memoryId,
            content: {
              type: "treasury_transaction",
              text: `Transferred ${amount} SOL to ${recipient}`,
              status: "completed",
              amountSOL: amount,
              recipientAddress: recipient,
              recipientUserId: registeredUser?.userId,
              txHash: signature,
              timestamp: Date.now()
            },
            roomId: ROOM_IDS.TREASURY,  // Transfer records should be in treasury room
            userId: ('userId' in content && typeof content.userId === 'string') ? stringToUuid(content.userId) : agent.getAgentId(),
            agentId: agent.getAgentId(),
            unique: true
          });

          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-success-${Date.now()}`),
              text: `Transfer successful! View transaction: ${explorerUrl}`,
              status: "executed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });

          if ('content' in content && typeof content.content === 'object' && content.content !== null) {
            (content.content as any).transactionComplete = true;
            (content as unknown as TransferState).lastProcessedMessageId = content.id;
          }

        } catch (error) {
          elizaLogger.error("Transfer failed:", error);
          await agent.sendMessage({
            type: "transfer_response",
            content: {
              type: "transfer_response",
              id: stringToUuid(`transfer-error-${Date.now()}`),
              text: `Transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              status: "failed",
              agentId: agent.getAgentId(),
              createdAt: Date.now(),
              updatedAt: Date.now()
            },
            from: agent.getAgentType(),
            to: "ALL"
          });
        }
      } catch (transferError) {
        elizaLogger.error("Error in transfer transaction:", transferError);
        throw transferError;
      }
    } finally {
      await agent.releaseDistributedLock(lock);
    }
  } catch (error) {
    elizaLogger.error("Error in transfer handler:", error);
    await agent.sendMessage({
      type: "transfer_response",
      content: {
        type: "transfer_response",
        id: stringToUuid(`transfer-error-${Date.now()}`),
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        status: "failed",
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
 * Check the wallet balance
 */
async function checkWalletBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
  const balance = await connection.getBalance(publicKey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Handle a SOL transfer
 */
async function handleSolTransfer(
  agent: TreasuryAgent,
  connection: Connection,
  recipient: string,
  amount: number
): Promise<string> {
  try {
    // Get wallet keypair using getWalletKey
    const { keypair } = await getWalletKey(agent.getRuntime(), true);
    if (!keypair) {
      throw new Error("Failed to get wallet keypair");
    }

    const recipientPubkey = new PublicKey(recipient);

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: recipientPubkey,
      lamports: amount * LAMPORTS_PER_SOL
    });

    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [transferInstruction]
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([keypair]);

    return await connection.sendTransaction(transaction);
  } catch (error) {
    elizaLogger.error("Error in handleSolTransfer:", error);
    throw error;
  }
} 