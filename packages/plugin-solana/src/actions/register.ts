// packages/plugin-solana/src/actions/register.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    Content,
    stringToUuid,
    generateObject,
    ModelClass,
    composeContext,
    IMemoryManager,
  } from "@elizaos/core";
  import { Message } from "discord.js";
  import { validateCommandWithParam } from "../utils/commandValidation.js";
  import { ROOM_IDS } from "../shared/constants";


  const examples: ActionExample[][] = [
    [
        {
            user: "user",
            content: {
                text: "!register 7TYCNbf8cNGv5BuzXMviRCAdSRzjFCUrAvGkdqQ1UUcS",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "!register wallet 6tLt8iR3FoJQFbpLoZh6vocMSSjehSBaf6aw6rjhJ8vQ",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "!register my wallet EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@1331891537843327058> !register So11111111111111111111111111111111111111112",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@1331891537843327058> !register wallet Asb1aAZrHjyKgmbNGYrUWsBVWX31eL1VLV1RWoSADAUP",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ],
    [
        {
            user: "user",
            content: {
                text: "<@1331891537843327058> !register my wallet 3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
                action: "register",
            },
        },
        {
            user: "Vela",
            content: {
                text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool.",
                action: "register"
            },
        },
    ]
];

interface RegisterContent extends Content {
  error?: string;
}

// Add schema definition
const registerValidationTemplate = `
You are validating a Solana wallet address registration command.
The wallet address should be a base58-encoded string between 32-44 characters.

Wallet address to validate: {{walletAddress}}

Respond with a JSON object:
{
    "isValid": boolean,
    "walletAddress": string,
    "reason": string
}
`;

export const register: Action = {
  name: "register",
  description: "Registers a user's Solana wallet address",
  examples,
  similes: ["link wallet", "connect wallet", "save address"],
  suppressInitialMessage: true,
  validate: async (runtime: IAgentRuntime, message: Memory) => {
      // Skip if message is from the assistant
      if (message.userId === runtime.agentId) {
          elizaLogger.debug("Skipping validation for assistant's own message");
          return false;
      }

      const text = message.content.text.trim();

      // Check if this looks like a register command attempt
      const isRegisterAttempt = /^(?:<@!?\d+>|@\d+)?\s*!register\b/.test(text);
      if (!isRegisterAttempt) {
          return false;
      }

      // First validate command format
      const match = validateCommandWithParam(text, "register", "[1-9A-HJ-NP-Za-km-z]{32,44}");
      if (!match) {
          (message.content as RegisterContent).error = "Invalid command format. Please use:\n!register <solana_address>\n\nExample:\n!register 7TYCNbf8cNGv5BuzXMviRCAdSRzjFCUrAvGkdqQ1UUcS";
          return false;
      }

      // If basic validation passes, use template validation
      try {
          const walletAddress = match[1];
          const context = composeContext({
              state: {
                  walletAddress,
                  bio: "",
                  lore: "",
                  messageDirections: "",
                  postDirections: "",
                  roomId: message.roomId,
                  actors: "",
                  recentMessages: "",
                  recentMessagesData: []
              },
              template: registerValidationTemplate
          });

          const validationResult = await generateObject({
              runtime,
              context,
              modelClass: ModelClass.SMALL
          });

          if (validationResult && 
              typeof validationResult === 'object' && 
              'isValid' in validationResult && 
              'walletAddress' in validationResult) {
              return validationResult.isValid && validationResult.walletAddress === walletAddress;
          }

          return false;
      } catch (error) {
          elizaLogger.error("Error in register validation:", error);
          return false;
      }
  },
  handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State | undefined,
      _options: { [key: string]: unknown } = {},
      callback?: HandlerCallback
  ): Promise<boolean> => {
      const memoryManager = runtime.messageManager as IMemoryManager;
      
      try {
          elizaLogger.debug('[HANDLER] Processing register request', {
              messageContent: message.content,
              userId: message.userId,
              roomId: message.roomId
          });

          // Start transaction
          await memoryManager.beginTransaction();

          // If there's an error from validation, return it
          const error = (message.content as RegisterContent).error;
          if (error) {
              await memoryManager.rollbackTransaction();
              callback?.({
                  text: error,
                  suppressLLM: true
              });
              return false;
          }

          // Extract wallet address using the same validation
          const match = validateCommandWithParam(message.content.text.trim(), "register", "[1-9A-HJ-NP-Za-km-z]{32,44}");
          if (!match) {
              await memoryManager.rollbackTransaction();
              callback?.({
                  text: "The wallet address format is invalid. Please provide a valid Solana wallet address."
              });
              return false;
          }

          const walletAddress = match[1];

          // Check if wallet is already registered
          const existingRegistrations = await memoryManager.getMemories({
              roomId: runtime.agentId,
              count: 1000,
          });

          // Check if wallet is registered by this user
          const alreadyRegistered = existingRegistrations.some(mem =>
              mem.content.type === "register_wallet" &&
              mem.content.walletAddress === walletAddress &&
              mem.userId === message.userId
          );

          if (alreadyRegistered) {
              await memoryManager.rollbackTransaction();
              elizaLogger.debug("Register handler - wallet already registered to user");
              callback?.({
                  text: "This wallet is already registered to your account. Use !deposit to contribute to the pool, or alternatively !balance to check your status."
              });
              return true;
          }

          // Check if wallet is registered by another user
          const existingWalletUser = existingRegistrations.find(mem =>
              mem.content.type === "register_wallet" &&
              mem.content.walletAddress === walletAddress &&
              mem.userId !== message.userId
          );

          if (existingWalletUser) {
              await memoryManager.rollbackTransaction();
              elizaLogger.debug("Register handler - wallet registered to different user");
              callback?.({
                  text: "This wallet address is already registered to another user."
              });
              return false;
          }

          // Create registration record
          const memoryId = stringToUuid(`register-${walletAddress}-${Date.now()}`);
          const discordMessage = state?.discordMessage as Message;
          const discordSnowflake = discordMessage?.author?.id;

          if (!discordSnowflake) {
              await memoryManager.rollbackTransaction();
              elizaLogger.error("Could not get Discord snowflake ID from message");
              callback?.({
                  text: "Sorry, I encountered an error processing your request. Please try again later."
              });
              return false;
          }

          await memoryManager.createMemory({
              id: memoryId,
              content: {
                  type: "wallet_registration",
                  text: `Connected address ${walletAddress}`,
                  walletAddress: walletAddress,
                  discordId: discordSnowflake,
                  timestamp: Date.now()
              },
              roomId: ROOM_IDS.DAO,
              userId: message.userId,
              agentId: runtime.agentId,
              unique: true
          });

          // Commit transaction
          await memoryManager.commitTransaction();

          elizaLogger.debug("Register handler - successfully registered wallet", {
              walletAddress,
              userId: message.userId
          });

          callback?.({
              text: "Wallet successfully registered ✅. Use !deposit to make your deposit to the DAO treasury pool."
          });
          return true;
      } catch (error) {
          await memoryManager.rollbackTransaction();
          elizaLogger.error("Error processing register request:", error);
          callback?.({
              text: "Sorry, I encountered an error processing your request. Please try again later.",
              suppressLLM: true
          });
          return false;
      }
  },
};
