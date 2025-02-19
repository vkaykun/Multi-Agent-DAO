// transfer.ts

import { elizaLogger } from "@elizaos/core";

import {
    Connection,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    type Action,
    stringToUuid,
    generateObject,
    ModelClass,
    composeContext,
    IMemoryManager,
} from "@elizaos/core";
import { getWalletKey } from "../keypairUtils.js";
import { Message } from "discord.js";
import { ROOM_IDS } from "../shared/constants";


export interface TransferContent extends Content {
    tokenAddress?: string;  // Optional for SOL transfers
    recipient: string;
    amount: number;
    token: string;  // Token symbol (e.g., "SOL", "BONK", etc.)
}

// Keep the confirmation state interface
interface TransferState extends State {
    pendingTransfer?: {
        recipient: string;
        amount: number;
        token: string;
        tokenAddress?: string;
        confirmed?: boolean;
        network?: string;
        currentBalance?: number;
        timestamp: number;
    };
    transactionComplete?: boolean;  // Flag to prevent re-processing
    lastProcessedMessageId?: string;  // Track which message we've already handled
}

async function checkWalletBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
    try {
        const balance = await connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        elizaLogger.error("Error checking wallet balance:", error);
        throw error;
    }
}


async function handleSolTransfer(
    connection: Connection,
    senderKeypair: any,
    recipient: string,
    amount: number
): Promise<string> {
    const recipientPubkey = new PublicKey(recipient);

    const transferInstruction = SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: amount * LAMPORTS_PER_SOL
    });

    const messageV0 = new TransactionMessage({
        payerKey: senderKeypair.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [transferInstruction]
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([senderKeypair]);

    return await connection.sendTransaction(transaction);
}

export default {
    name: "TRANSFER",
    similes: [
        "SEND",
        "TRANSFER_TOKEN",
        "SEND_TOKEN",
        "SEND_SOL",
        "TRANSFER_SOL",
        "PAY"
    ],
    description: "Transfer SOL or tokens from the agent's wallet to another address",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Use the original text (without lowercasing for mention IDs) and trim it
        const text = message.content.text.trim();

        // More specific pattern for transfer commands that matches:
        // 1. Optional mention prefix
        // 2. "transfer" or "send" keyword
        // 3. Amount (required)
        // 4. "SOL" (case insensitive)
        // 5. Optional "to" keyword
        // 6. Wallet address (32-44 characters)
        const transferRegex = /^(?:<@\d+>\s+)?(?:transfer|send)\s+(\d*\.?\d+)\s*(?:SOL|sol)\s+(?:to\s+)?([A-HJ-NP-Za-km-z1-9]{32,44})$/i;
        const match = text.match(transferRegex);

        elizaLogger.debug('[TRANSFER validate] Checking message:', {
            messageId: message.id,
            text: text,
            hasMatch: !!match
        });

        if (!match) {
            elizaLogger.debug('[TRANSFER validate] No match for transfer command');
            return false;
        }

        const amount = parseFloat(match[1]);
        const recipient = match[2];

        // Validate amount
        if (isNaN(amount) || amount <= 0) {
            elizaLogger.debug('[TRANSFER validate] Invalid amount:', amount);
            return false;
        }

        // Validate recipient address format
        try {
            new PublicKey(recipient);
        } catch (err) {
            elizaLogger.debug('[TRANSFER validate] Invalid recipient address:', recipient);
            return false;
        }

        // Check for private key
        const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY") || runtime.getSetting("WALLET_PRIVATE_KEY");
        if (!privateKey) {
            elizaLogger.error("[TRANSFER validate] Missing private key in environment");
            return false;
        }

        // Get the authorized user ID from environment
        const authorizedUserId = runtime.getSetting("AUTHORIZED_USER_ID");
        if (!authorizedUserId) {
            elizaLogger.error("[TRANSFER validate] No authorized user configured");
            return false;
        }

        // Check if the message is from the authorized user
        if (message.userId !== authorizedUserId) {
            elizaLogger.error(`[TRANSFER validate] Unauthorized transfer attempt from user: ${message.userId}`);
            return false;
        }

        elizaLogger.debug('[TRANSFER validate] Valid transfer command:', {
            amount,
            recipient,
            isAuthorized: true
        });

        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const memoryManager = runtime.messageManager as IMemoryManager;
        
        try {
            elizaLogger.debug('[TRANSFER handler] Starting transfer with message:', {
                messageId: message.id,
                userId: message.userId,
                content: message.content
            });

            // Skip if already processed
            if ((state as TransferState).lastProcessedMessageId === message.id) {
                elizaLogger.debug('[TRANSFER handler] Skipping already processed message');
                return true;
            }

            // Start transaction
            await memoryManager.beginTransaction();

            // Parse the transfer details directly from the message
            const text = message.content.text.trim();
            const transferRegex = /^(?:<@\d+>\s+)?(?:transfer|send)\s+(\d*\.?\d+)\s*(?:SOL|sol)\s+(?:to\s+)?([A-HJ-NP-Za-km-z1-9]{32,44})$/i;
            const match = text.match(transferRegex);

            if (!match) {
                await memoryManager.rollbackTransaction();
                callback?.({
                    text: "Invalid transfer format. Please use: transfer <amount> SOL to <address>"
                });
                return true;
            }

            const amount = parseFloat(match[1]);
            const recipient = match[2];

            elizaLogger.debug('[TRANSFER handler] Getting wallet key...');
            const { keypair: senderKeypair } = await getWalletKey(runtime, true);
            if (!senderKeypair) {
                await memoryManager.rollbackTransaction();
                callback?.({
                    text: "Failed to get wallet keypair"
                });
                return false;
            }

            elizaLogger.debug('[TRANSFER handler] Connecting to Solana...');
            const connection = new Connection(
                runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
            );

            // Check balance
            elizaLogger.debug('[TRANSFER handler] Checking balance...');
            const currentBalance = await checkWalletBalance(connection, senderKeypair.publicKey);
            elizaLogger.debug(`[TRANSFER handler] Current balance: ${currentBalance} SOL`);

            if (amount >= currentBalance) {
                await memoryManager.rollbackTransaction();
                callback?.({
                    text: `Insufficient balance. You have ${currentBalance} SOL but tried to send ${amount} SOL.`
                });
                return true;
            }

            try {
                elizaLogger.debug("[TRANSFER handler] Executing SOL transfer...");
                const signature = await handleSolTransfer(
                    connection,
                    senderKeypair,
                    recipient,
                    amount
                );

                elizaLogger.info("Transfer successful, signature:", signature);
                const explorerUrl = `https://explorer.solana.com/tx/${signature}`;

                // Look up if this is a transfer to a registered wallet
                const registeredWallets = await memoryManager.getMemories({
                    roomId: runtime.agentId,
                    count: 1000
                });

                // Find if recipient matches any registered wallet
                const registeredUser = registeredWallets.find(mem =>
                    mem.content.type === "registered_wallet" &&
                    mem.content.publicKey === recipient
                );

                // Generate unique memory ID for transfer record
                const memoryId = stringToUuid(`${message.userId}-transfer-${signature}-${Date.now()}`);

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
                    userId: message.userId,
                    agentId: runtime.agentId,
                    unique: true
                });

                // Commit transaction
                await memoryManager.commitTransaction();

                callback?.({
                    text: `Transfer successful! View transaction: ${explorerUrl}`
                });
                (state as TransferState).lastProcessedMessageId = message.id;

                return true;
            } catch (error) {
                await memoryManager.rollbackTransaction();
                elizaLogger.error("Transfer failed:", error);
                callback?.({
                    text: `Transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
                return true;
            }
        } catch (error) {
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Error in transfer handler:", error);
            callback?.({
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
            return true;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Send 1 SOL to 9jW8FPr6BSSsemWPV22UUCzSqkVdTp6HTyPqeqyuBbCa" }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Transfer successful! View transaction: https://explorer.solana.com/tx/...",
                    action: "TRANSFER"
                }
            }
        ]
    ]
} as Action;
