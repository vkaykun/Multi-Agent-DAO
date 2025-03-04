// Treasury Agent Swap Handler
// Contains logic for handling token swaps

import {
  elizaLogger,
  stringToUuid,
  UUID,
  Memory,
  Content,
  composeContext,
  generateObject,
  ModelClass,
  IMemoryManager,
} from "@elizaos/core";
import {
  BaseContent,
  AgentMessage,
  ContentStatus,
  SwapRequest,
  DistributedLock,
  AgentType,
} from "../../shared/types/base.ts";
import { DAOMemoryType } from "../../shared/types/memory.ts";
import { ROOM_IDS } from "../../shared/constants.ts";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { jupiterSwap, raydiumSwap, pumpFunSwap, getTokenDecimals } from "../../utils/swapUtilsOrAtaHelper.ts";
import { toBN, BigNumber } from "../../utils/bignumber.ts";
import { TOKEN_MINTS } from "../../utils/governanceUtils.ts";
import { ITreasuryAgentForHandlers } from "./types/handlerTypes.ts";
import { v4 as uuidv4 } from 'uuid';

// Constants for swap operations
const JUPITER_API_URL = "https://quote-api.jup.ag/v6";
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const QUOTE_TIMEOUT_MS = 5000; // 5 seconds
const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

// Timeouts for different operations
const SWAP_TIMEOUTS = {
  SECURITY_CHECK: 1000, // 1 second
  QUOTE: 3000,         // 3 seconds
  SWAP: 15000,         // 15 seconds
};

// Error handling interfaces
interface ErrorWithMessage {
  message: string;
  name?: string;
}

interface SwapError {
  error: string;
}

interface JupiterQuoteResponse {
  error?: string;
  outAmount?: string;
  routePlan?: any[];
  priceImpactPct?: number;
  outAmountWithSlippage?: string;
}

interface TokenApiResponse {
  tokens: Array<{ address: string; symbol: string; }>;
}

interface SwapContext {
  swapService: any;
  connection: Connection;
  keypair: Keypair;
}

// Type guards
function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function isSwapError(error: unknown): error is SwapError {
  return typeof error === 'object' && error !== null && 'error' in error && typeof (error as SwapError).error === 'string';
}

function isValidQuoteResponse(data: unknown): data is JupiterQuoteResponse {
  const response = data as JupiterQuoteResponse;
  return response && typeof response === 'object' && 
      (!response.error || typeof response.error === 'string') &&
      (!response.outAmount || typeof response.outAmount === 'string') &&
      (!response.priceImpactPct || typeof response.priceImpactPct === 'number') &&
      (!response.routePlan || Array.isArray(response.routePlan));
}

function isTokenApiResponse(data: unknown): data is TokenApiResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'tokens' in data &&
    Array.isArray((data as TokenApiResponse).tokens)
  );
}

// LLM extraction template
export const swapTemplate = `You are a swap parameter extractor. Your task is to extract swap parameters from the user's message and format them in JSON.

PREPROCESSING INSTRUCTIONS:
1. EXACT PATTERN MATCHING:
    - "swap X [TOKEN1] for [TOKEN2]" → amount=X (MUST be a number), input=TOKEN1, output=TOKEN2
    - "swap [TOKEN1] for [TOKEN2]" → amount=null, input=TOKEN1, output=TOKEN2

2. TOKEN ADDRESS RULES:
    - If you see "SOL" (case-insensitive), you MUST use "So11111111111111111111111111111111111111112"
    - If you see a 44-character address, you MUST use it EXACTLY as provided
    - DO NOT try to resolve any other token symbols to addresses
    - DO NOT make up or generate random addresses
    - DO NOT try to guess token symbols or addresses

3. AMOUNT RULES:
    - CRITICAL: The amount MUST be returned as a NUMBER, not a string
    - Extract the EXACT number that appears after "swap" and before the input token
    - DO NOT modify, round, or change the amount in any way
    - Use the EXACT amount specified in the message (e.g., if user says "swap 3500", use 3500)
    - Support both whole numbers (3500) and decimals (3500.5)
    - If no amount is found, return null
    - NEVER make up or guess an amount - use exactly what's in the message

4. CRITICAL: When you see a 44-character address like "CwismAYtSdQbo3MLLY4mob31UhF6kwo1ZG835L3eDqFw":
    - If it's the input token, set inputTokenCA to this exact address
    - If it's the output token, set outputTokenCA to this exact address
    - Set the corresponding tokenSymbol to null

5. CRITICAL: When you see "SOL" (case-insensitive):
    - You MUST set the tokenSymbol to "SOL"
    - You MUST set the tokenCA to "So11111111111111111111111111111111111111112"
    - This applies to both input and output tokens

CRITICAL RULES:
1. The amount MUST be a number in the JSON, not a string (3500 not "3500")
2. When you see a 44-character address, you MUST use it exactly as provided
3. When you see "SOL", you MUST use "So11111111111111111111111111111111111111112"
4. DO NOT make up or generate random addresses
5. DO NOT try to guess token symbols or addresses
6. DO NOT modify the amount - use exactly what's in the message
7. If you can't determine something with 100% certainty, use null

Now, analyze this message:

{{message.content.text}}

Respond with ONLY a JSON markdown block containing the extracted values. Use null for any values that cannot be determined. Follow this schema exactly:
\`\`\`json
{
    "inputTokenSymbol": string | null,
    "outputTokenSymbol": string | null,
    "inputTokenCA": string | null,
    "outputTokenCA": string | null,
    "amount": number | null
}
\`\`\``;

// Configure BigNumber
BigNumber.config({
    EXPONENTIAL_AT: 1e9,
    DECIMAL_PLACES: 20,
});

// Utility Functions
function getErrorMessage(error: unknown): string {
    if (isErrorWithMessage(error)) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
}

// Error logging helper
function formatErrorLog(error: unknown): { error: string; [key: string]: unknown } {
    return {
        error: getErrorMessage(error)
    };
}

// Parse the swap amount from the message text
function parseUserAmount(text: string): number | null {
    try {
        const cleanText = text.toLowerCase().replace(/[$,]/g, "");
        const swapMatch = cleanText.match(/swap\s+(\d*\.?\d+)/i);
        if (swapMatch) {
            const amount = parseFloat(swapMatch[1]);
            return !isNaN(amount) ? amount : null;
        }
        return null;
    } catch {
        return null;
    }
}

// Token validation and extraction functions
function detectSOLToken(text: string, position: "input" | "output"): boolean {
    const normalizedText = text.toLowerCase();
    const solPattern = /\b(sol|wsol)\b/;
    if (position === "output") {
        const forIndex = normalizedText.indexOf("for");
        if (forIndex === -1) return false;
        const textAfterFor = normalizedText.slice(forIndex);
        return solPattern.test(textAfterFor);
    } else {
        const forIndex = normalizedText.indexOf("for");
        if (forIndex === -1) return solPattern.test(normalizedText);
        const textBeforeFor = normalizedText.slice(0, forIndex);
        return solPattern.test(textBeforeFor);
    }
}

function validateTokenAddress(address: string | null): boolean {
    if (!address) return false;
    if (address === SOL_ADDRESS) return true;
    return /^[A-HJ-NP-Za-km-z1-9]{43,44}(?:pump)?$/.test(address);
}

function extractTokenAddresses(text: string): { input: string | null; output: string | null } {
    const addresses: string[] = [];
    const pattern = /([A-HJ-NP-Za-km-z1-9]{43,44}(?:pump)?)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (validateTokenAddress(match[1])) {
            addresses.push(match[1]);
        }
    }
    if (addresses.length === 2) {
        return { input: addresses[0], output: addresses[1] };
    }
    if (addresses.length === 1) {
        const forIndex = text.toLowerCase().indexOf("for");
        if (forIndex === -1) return { input: addresses[0], output: null };
        const addressIndex = text.indexOf(addresses[0]);
        return addressIndex < forIndex
            ? { input: addresses[0], output: null }
            : { input: null, output: addresses[0] };
    }
    return { input: null, output: null };
}

// Validate and correct the LLM response for token parameters
const validateLLMResponse = (content: any, messageText: string) => {
    elizaLogger.info("Validating LLM response:", content);
    const extractedAddresses = extractTokenAddresses(messageText);
    const extractedAmount = parseUserAmount(messageText);
    
    if (extractedAmount !== null) {
        content.amount = extractedAmount;
        elizaLogger.info("Using extracted amount:", extractedAmount);
    } else {
        content.amount = null;
        elizaLogger.warn("Could not extract amount from message");
    }
    
    if (!validateTokenAddress(content.inputTokenCA) || 
        (extractedAddresses.input && content.inputTokenCA !== extractedAddresses.input)) {
        content.inputTokenCA = extractedAddresses.input;
        elizaLogger.info("Corrected input token address:", content.inputTokenCA);
    }
    
    if (!validateTokenAddress(content.outputTokenCA) || 
        (extractedAddresses.output && content.outputTokenCA !== extractedAddresses.output)) {
        content.outputTokenCA = extractedAddresses.output;
        elizaLogger.info("Corrected output token address:", content.outputTokenCA);
    }
    
    if (detectSOLToken(messageText, "input")) {
        content.inputTokenSymbol = "SOL";
        content.inputTokenCA = SOL_ADDRESS;
        elizaLogger.info("Set input token to SOL");
    }
    
    if (detectSOLToken(messageText, "output")) {
        content.outputTokenSymbol = "SOL";
        content.outputTokenCA = SOL_ADDRESS;
        elizaLogger.info("Set output token to SOL");
    }
    
    return content;
};

// Convert amount to token decimals safely
async function convertAmountToDecimals(
    connection: Connection,
    amount: number,
    tokenMint: string
): Promise<BigNumber> {
    try {
        const decimals = await getTokenDecimals(connection, tokenMint);
        elizaLogger.info(`Token decimals for ${tokenMint}: ${decimals}`);
        const amountBN = new BigNumber(amount);
        const multiplier = new BigNumber(10).pow(decimals);
        const rawAmount = amountBN.times(multiplier);
        if (rawAmount.gt(new BigNumber(Number.MAX_SAFE_INTEGER))) {
            throw new Error("Amount too large for safe processing");
        }
        return rawAmount;
    } catch (error) {
        elizaLogger.error("Error converting amount:", error);
        throw error;
    }
}

// Check if a token is a standard SPL token
async function isStandardSPLToken(
    connection: Connection,
    mintAddress: string
): Promise<boolean> {
    try {
        if (mintAddress === SOL_ADDRESS) return false;
        const mintPubkey = new PublicKey(mintAddress);
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        return accountInfo !== null && accountInfo.owner.equals(TOKEN_PROGRAM_ID);
    } catch (error) {
        return false;
    }
}

// Quick security check for a token address
async function quickSecurityCheck(
    tokenCA: string,
): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SWAP_TIMEOUTS.SECURITY_CHECK);
        
        if (tokenCA === SOL_ADDRESS) {
            clearTimeout(timeoutId);
            return true;
        }
        
        const response = await fetch(
            `${JUPITER_API_URL}/quote?inputMint=${SOL_ADDRESS}&outputMint=${tokenCA}&amount=100000`,
            { signal: controller.signal }
        );
        
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        elizaLogger.warn("[Security Check] Skipped:", formatErrorLog(error));
        return true;
    }
}

// Quick token validation using cached price info when possible
async function quickTokenValidation(
    mintAddress: string,
    agent: ITreasuryAgentForHandlers
): Promise<boolean> {
    if (mintAddress === SOL_ADDRESS) return true;
    
    try {
        // First do security check
        const securityCheckPassed = await quickSecurityCheck(mintAddress);
        if (!securityCheckPassed) {
            return false;
        }
        
        // Check if it's a valid SPL token
        const connection = new Connection(agent.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com");
        const isSPLToken = await isStandardSPLToken(connection, mintAddress);
        if (!isSPLToken) {
            return false;
        }

        // Try to get price info from cache first
        const priceInfo = await agent.swapService.getTokenPrice(mintAddress);
        if (priceInfo.price > 0 && !priceInfo.error) {
            return true;
        }
        
        // If price info not available, fallback to Jupiter quote check
        const quoteUrl = `${JUPITER_API_URL}/quote?inputMint=${SOL_ADDRESS}&outputMint=${mintAddress}&amount=100000000`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
        
        const response = await fetch(quoteUrl, { signal: controller.signal });
        if (response.status === 401) {
            throw new Error("Unauthorized: Check API key permissions");
        }
        
        const data = await response.json();
        clearTimeout(timeoutId);
        
        return Boolean(!data.error && data.outAmount && data.routePlan?.length > 0);
    } catch (error) {
        elizaLogger.warn("Quick token validation error:", formatErrorLog(error));
        return false;
    }
}

// Update IMemoryManager interface at the top of the file
interface ExtendedMemoryManager extends IMemoryManager {
    getMemoryWithLock(id: UUID): Promise<Memory | null>;
    updateMemoryWithVersion(id: UUID, update: any, version: number): Promise<boolean>;
    beginTransaction(): Promise<void>;
    commitTransaction(): Promise<void>;
    rollbackTransaction(): Promise<void>;
}

/**
 * Handles a swap request with comprehensive validation and execution
 */
export async function handleSwapRequest(
    agent: ITreasuryAgentForHandlers,
    request: SwapRequest
): Promise<{ signature: string; price: number }> {
    const memoryManager = agent.getRuntime().messageManager as ExtendedMemoryManager;
    
    try {
        elizaLogger.info("Processing swap request", {
            fromToken: request.fromToken,
            toToken: request.toToken,
            amount: request.amount,
            requestId: request.requestId,
            reason: request.reason
        });

        // Create a unique swap ID and acquire a lock to prevent concurrent swaps
        const requestIdStr = request.id.toString();
        const swapId = stringToUuid(`swap-${requestIdStr}-${Date.now()}`);
        const lockKey = `swap-${requestIdStr}`;
        const lock = await agent.acquireDistributedLock(lockKey, agent.agentSettings.swapTimeout);
        
        if (!lock) {
            throw new Error('Could not acquire swap lock - another swap might be in progress');
        }

        try {
            // Start transaction
            await memoryManager.beginTransaction();

            // Get memory with lock to track swap status
            const memoryId = stringToUuid(`swap-${requestIdStr}-${Date.now()}`);
            const memory = await memoryManager.getMemoryWithLock(memoryId);
            
            if (memory) {
                const content = memory.content as any;
                const success = await memoryManager.updateMemoryWithVersion(
                    memoryId,
                    {
                        content: {
                            ...content,
                            status: "executing",
                            updatedAt: Date.now()
                        }
                    },
                    content.version || 1
                );

                if (!success) {
                    throw new Error('Concurrent swap update detected - please retry');
                }
            }

            // Determine token addresses with proper validation
            const inputTokenCA = TOKEN_MINTS[request.fromToken.toUpperCase()] || request.fromToken;
            const outputTokenCA = TOKEN_MINTS[request.toToken.toUpperCase()] || request.toToken;

            // Validate tokens exist with thorough checks
            if (!inputTokenCA || !outputTokenCA) {
                throw new Error(`Invalid token address: ${!inputTokenCA ? request.fromToken : request.toToken}`);
            }

            // Validate tokens are legitimate and have liquidity
            const [inputValid, outputValid] = await Promise.all([
                quickTokenValidation(inputTokenCA, agent),
                quickTokenValidation(outputTokenCA, agent)
            ]);

            if (!inputValid) {
                throw new Error(`Input token validation failed: ${request.fromToken}`);
            }

            if (!outputValid) {
                throw new Error(`Output token validation failed: ${request.toToken}`);
            }

            // Get the optimal swap route with fallbacks to different DEXes
            const route = await getOptimalSwapRoute(inputTokenCA, outputTokenCA, toBN(request.amount));

            // Create a connection
            const connection = new Connection(
                agent.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
            );

            // Get quote to check price impact
            const quote = await getQuoteForRoute(agent, inputTokenCA, outputTokenCA, parseFloat(request.amount));
            
            // Check if price impact is too high (over 5%)
            if (quote.impact > 5.0) {
                throw new Error(`Price impact too high: ${quote.impact.toFixed(2)}% - swap aborted for safety`);
            }

            // Get keypair for signing
            const keypair = await agent.getKeyPair();
            if (!keypair) {
                throw new Error("Failed to get wallet keypair");
            }

            // Execute the swap with proper error handling
            const result = await executeSwapWithRoute(connection, keypair, route, parseFloat(request.amount));

            // Record the swap in Treasury with detailed metadata
            await memoryManager.createMemory({
                id: stringToUuid(`swap-${result.signature}-${Date.now()}`),
                userId: agent.getAgentId(),
                agentId: agent.getAgentId(),
                roomId: ROOM_IDS.DAO,
                content: {
                    type: "treasury_transaction" as DAOMemoryType,
                    text: `Swapped ${request.amount} ${request.fromToken} for ${request.toToken}`,
                    status: "executed" as ContentStatus,
                    txSignature: result.signature,
                    price: result.price,
                    requestId: request.requestId,
                    reason: request.reason,
                    metadata: {
                        txSignature: result.signature,
                        fromToken: request.fromToken,
                        toToken: request.toToken,
                        fromAmount: request.amount,
                        toAmount: result.outputAmount.toString(),
                        price: quote.price,
                        transactionType: "swap",
                        timestamp: Date.now(),
                        requestId: request.requestId,
                        reason: request.reason,
                        explorerUrl: `https://explorer.solana.com/tx/${result.signature}`
                    }
                },
                unique: true
            });

            // Create swap execution result memory for tracking
            await memoryManager.createMemory({
                id: stringToUuid(`swap-result-${result.signature}-${Date.now()}`),
                userId: agent.getAgentId(),
                agentId: agent.getAgentId(),
                roomId: ROOM_IDS.DAO,
                content: {
                    type: "swap_execution_result" as DAOMemoryType,
                    text: `Swap execution completed: ${request.amount} ${request.fromToken} to ${result.outputAmount} ${request.toToken}`,
                    status: "executed" as ContentStatus,
                    success: true,
                    swapId,
                    signature: result.signature,
                    price: result.price,
                    metadata: {
                        txSignature: result.signature,
                        fromToken: request.fromToken,
                        toToken: request.toToken,
                        fromAmount: request.amount,
                        toAmount: result.outputAmount.toString(),
                        price: quote.price,
                        timestamp: Date.now(),
                        requestId: request.requestId,
                        reason: request.reason
                    }
                },
                unique: true
            });

            // Create a swap completed event for other agents to react to
            await memoryManager.createMemory({
                id: stringToUuid(`swap-completed-${result.signature}-${Date.now()}`),
                userId: agent.getAgentId(),
                agentId: agent.getAgentId(),
                roomId: ROOM_IDS.DAO,
                content: {
                    type: "swap_completed" as DAOMemoryType,
                    text: `Swap completed: ${request.amount} ${request.fromToken} to ${result.outputAmount} ${request.toToken}`,
                    status: "executed" as ContentStatus,
                    success: true,
                    swapId,
                    inputToken: request.fromToken,
                    outputToken: request.toToken,
                    inputAmount: request.amount,
                    outputAmount: result.outputAmount.toString(),
                    metadata: {
                        txSignature: result.signature,
                        inputSymbol: request.fromToken,
                        outputSymbol: request.toToken,
                        price: result.price,
                        timestamp: Date.now(),
                        requestId: request.requestId,
                        reason: request.reason
                    }
                },
                unique: true
            });

            // Commit transaction
            await memoryManager.commitTransaction();

            // Return the result
            return {
                signature: result.signature,
                price: result.price
            };
        } finally {
            // Always release the lock when done
            await agent.releaseDistributedLock(lock);
        }
    } catch (error) {
        // Rollback transaction on error
        await memoryManager.rollbackTransaction();
        elizaLogger.error("Error handling swap request:", error);
        throw error;
    }
}

/**
 * Executes a swap with the given route
 */
export async function executeSwapWithRoute(
    connection: Connection,
    keypair: Keypair,
    route: { inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: string },
    amount: number
): Promise<{ signature: string; inputAmount: number; outputAmount: number; price: number }> {
    try {
        // Convert amount to proper decimals
        const decimals = await getTokenDecimals(connection, route.inputMint);
        const inputAmount = amount * Math.pow(10, decimals);

        // Execute swap based on route with proper error handling
        let result;
        switch (route.bestRoute) {
            case "jupiter":
                result = await jupiterSwap(connection, keypair, route.inputMint, route.outputMint, inputAmount);
                break;
            case "raydium":
                result = await raydiumSwap(connection, keypair, route.inputMint, route.outputMint, inputAmount);
                break;
            case "pumpfun":
                result = await pumpFunSwap(connection, keypair, route.inputMint, route.outputMint, inputAmount);
                break;
            default:
                throw new Error(`Unsupported swap route: ${route.bestRoute}`);
        }

        if (!result || !result.signature) {
            throw new Error("Swap execution failed - no signature returned");
        }

        return {
            signature: result.signature,
            inputAmount: amount,
            outputAmount: result.outputAmount,
            price: 1.0 // Price will be updated by the caller using quote info
        };
    } catch (error) {
        elizaLogger.error("Error executing swap:", error);
        throw error;
    }
}

/**
 * Gets quote for a route using cached price info when possible
 */
async function getQuoteForRoute(
    agent: ITreasuryAgentForHandlers,
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number
): Promise<{ price: number; impact: number; minOutput: number }> {
    try {
        // Try to get prices from cache first
        const [inputPrice, outputPrice] = await Promise.all([
            agent.swapService.getTokenPrice(inputTokenCA),
            agent.swapService.getTokenPrice(outputTokenCA)
        ]);

        // If we have valid cached prices, use them for initial price calculation
        if (inputPrice.price > 0 && outputPrice.price > 0) {
            const expectedPrice = inputPrice.price / outputPrice.price;
            
            // Still get Jupiter quote for impact calculation
            const url = `${JUPITER_API_URL}/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=${DEFAULT_SLIPPAGE_BPS}`;
            const response = await fetch(url);
            
            if (response.status === 401) {
                throw new Error("Unauthorized: API key issue");
            }
            
            const data = await response.json();
            if (!data?.outAmount || !data?.priceImpactPct) {
                throw new Error("Invalid quote response");
            }

            const actualPrice = Number(data.outAmount) / amount;
            const impact = Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
            const minOutput = Number(data.outAmountWithSlippage);

            return { price: actualPrice, impact, minOutput };
        }

        // Fallback to Jupiter quote if cached prices not available
        const url = `${JUPITER_API_URL}/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=${DEFAULT_SLIPPAGE_BPS}`;
        const response = await fetch(url);
        
        if (response.status === 401) {
            throw new Error("Unauthorized: API key issue");
        }
        
        const data = await response.json();
        if (!data?.outAmount || !data?.priceImpactPct) {
            throw new Error("Invalid quote response");
        }
        
        return {
            price: Number(data.outAmount) / amount,
            impact: Number(data.priceImpactPct),
            minOutput: Number(data.outAmountWithSlippage)
        };
    } catch (error) {
        elizaLogger.error("Error getting quote for route:", error);
        throw error;
    }
}

// Get an optimized quote using Jupiter first, then Raydium, and finally PumpFun as fallback
async function getOptimalSwapRoute(
    inputTokenCA: string,
    outputTokenCA: string,
    rawAmount: BigNumber
): Promise<{ inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: "jupiter" | "raydium" | "pumpfun" }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SWAP_TIMEOUTS.QUOTE);
    
    try {
        // Try Jupiter route first with DEX exclusions for better pricing
        const jupiterQuoteUrl = `${JUPITER_API_URL}/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${rawAmount.toString()}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&onlyDirectRoutes=true&excludeDexes=Pump,Serum,Saber,Aldrin,Crema,Step,Cropper,GooseFX,Lifinity,Meteora,Invariant,Dradex,Openbook`;
        
        const response = await fetch(jupiterQuoteUrl, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "Cache-Control": "no-cache",
            },
        });
        
        if (response.status === 401) {
            throw new Error("Unauthorized: Check API key permissions for Jupiter API.");
        }
        
        if (response.ok) {
            clearTimeout(timeoutId);
            return {
                inputMint: inputTokenCA,
                outputMint: outputTokenCA,
                isPumpFunToken: false,
                bestRoute: "jupiter"
            };
        }

        // If Jupiter fails, try Raydium
        const raydiumResponse = await fetch("https://api.raydium.io/v2/main/quote", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
            },
            body: JSON.stringify({
                inputMint: inputTokenCA,
                outputMint: outputTokenCA,
                amount: rawAmount.toString(),
                slippage: 1.0,
            }),
            signal: controller.signal,
        });
        
        if (raydiumResponse.status === 401) {
            throw new Error("Unauthorized: Check API key permissions for Raydium API.");
        }
        
        if (raydiumResponse.ok) {
            clearTimeout(timeoutId);
            return {
                inputMint: inputTokenCA,
                outputMint: outputTokenCA,
                isPumpFunToken: false,
                bestRoute: "raydium"
            };
        }

        // Finally try PumpFun
        const pumpfunResponse = await fetch(`https://pumpportal.fun/api/pool/${outputTokenCA}`);
        if (pumpfunResponse.ok) {
            return {
                inputMint: inputTokenCA,
                outputMint: outputTokenCA,
                isPumpFunToken: true,
                bestRoute: "pumpfun"
            };
        }

        throw new Error("No valid quote found for this token pair");
    } catch (error) {
        clearTimeout(timeoutId);
        if (isErrorWithMessage(error) && error.name === "AbortError") {
            throw new Error("Quote fetch timed out");
        }
        throw error;
    }
} 