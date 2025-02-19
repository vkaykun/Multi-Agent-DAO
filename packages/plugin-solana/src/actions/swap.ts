// swap.ts

import {
    Action,
    ActionExample,
    composeContext,
    generateObject,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    settings,
    State,
    elizaLogger,
    stringToUuid,
    IMemoryManager,
} from "@elizaos/core";

import {
    Connection,
    PublicKey,
    Keypair,
    clusterApiUrl,
} from "@solana/web3.js";

import { toBN, BigNumber } from "../utils/bignumber.js";
import {
    getTokenDecimals,
    jupiterSwap,
    raydiumSwap,
    pumpFunSwap,
} from "./swaputilsOrAtaHelper.js";
import { getWalletKey } from "../keypairUtils.js";

import {
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { SwapService } from "../services/swapService.js";
import { ROOM_IDS } from "../shared/constants";

// -------------------------
// Type definitions
// -------------------------

export interface ExtendedStrategy {
    initialTakeProfit: number;
    secondTakeProfit: number;
    stopLoss: number;
    exitTimeframe: string;
    exitIndicator: string;
    initialSellPct?: number;
    secondSellPct?: number;
    useTA?: boolean;
}

export enum PendingSwapStatus {
    AWAITING_STRATEGY = "awaiting_strategy",
    CONFIRMED = "confirmed",
    CANCELLED = "cancelled",
}

export interface TradeMemory {
    type: "trade";
    text: string;
    status: "active" | "partial_exit" | "full_exit" | "stopped_out";
    inputToken: string;
    outputToken: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
    timestamp: number;
    strategy: ExtendedStrategy;
    partialSells?: Array<{
        timestamp: number;
        amount: number;
        price: number;
        reason?: string;
        signature?: string;
    }>;
    tokensRemaining?: number;
    [key: string]: any;
}

// Add interface near other type definitions
interface JupiterQuoteResponse {
    error?: string;
    outAmount?: string;
    routePlan?: any[];
    priceImpactPct?: number;
    outAmountWithSlippage?: string;
}

function isValidQuoteResponse(data: unknown): data is JupiterQuoteResponse {
    const response = data as JupiterQuoteResponse;
    return response && typeof response === 'object' && 
        (!response.error || typeof response.error === 'string') &&
        (!response.outAmount || typeof response.outAmount === 'string') &&
        (!response.priceImpactPct || typeof response.priceImpactPct === 'number') &&
        (!response.routePlan || Array.isArray(response.routePlan));
}

interface SwapError {
    error: string;
}

function isSwapError(error: unknown): error is SwapError {
    return typeof error === 'object' && error !== null && 'error' in error && typeof (error as SwapError).error === 'string';
}

// Add error type guard
interface ErrorWithMessage {
    message: string;
    name?: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
    return (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as Record<string, unknown>).message === 'string'
    );
}

interface TokenApiResponse {
    tokens: Array<{ address: string; symbol: string; }>;
}

function isTokenApiResponse(data: unknown): data is TokenApiResponse {
    return (
        typeof data === 'object' &&
        data !== null &&
        'tokens' in data &&
        Array.isArray((data as TokenApiResponse).tokens)
    );
}

// Add this near other interfaces
interface SwapContext {
    swapService: SwapService;
    connection: Connection;
    keypair: Keypair;
}

// -------------------------
// Utility Functions
// -------------------------

// Check if a token is a standard SPL token
async function isStandardSPLToken(
    connection: Connection,
    mintAddress: string
): Promise<boolean> {
    try {
        if (mintAddress === settings.SOL_ADDRESS) return false;
        const mintPubkey = new PublicKey(mintAddress);
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        return accountInfo !== null && accountInfo.owner.equals(TOKEN_PROGRAM_ID);
    } catch (error) {
        return false;
    }
}

// Swap template for LLM extraction (do not modify the schema)
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

Here are examples that match your exact use cases:

Message: "swap 3500 CwismAYtSdQbo3MLLY4mob31UhF6kwo1ZG835L3eDqFw for SOL"
\`\`\`json
{
    "inputTokenSymbol": null,
    "outputTokenSymbol": "SOL",
    "inputTokenCA": "CwismAYtSdQbo3MLLY4mob31UhF6kwo1ZG835L3eDqFw",
    "outputTokenCA": "So11111111111111111111111111111111111111112",
    "amount": 3500
}
\`\`\`

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

// Quick token validation using cached price info when possible
async function quickTokenValidation(
    mintAddress: string,
    swapService: SwapService
): Promise<boolean> {
    if (mintAddress === settings.SOL_ADDRESS) return true;
    try {
        // First do security check
        const securityCheckPassed = await quickSecurityCheck(mintAddress);
        if (!securityCheckPassed) {
            return false;
        }
        
        // Check if it's a valid SPL token
        const connection = new Connection(settings.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
        const isSPLToken = await isStandardSPLToken(connection, mintAddress);
        if (!isSPLToken) {
            return false;
        }

        // Try to get price info from cache first
        const priceInfo = await swapService.getTokenPrice(mintAddress);
        if (priceInfo.price > 0 && !priceInfo.error) {
            return true;
        }
        
        // If price info not available, fallback to Jupiter quote check
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${settings.SOL_ADDRESS}&outputMint=${mintAddress}&amount=100000000`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(quoteUrl, { signal: controller.signal });
        if (response.status === 401) {
            throw new Error("Unauthorized: Check API key permissions");
        }
        const rawData = await response.json();
        if (!isValidQuoteResponse(rawData)) {
            throw new Error("Invalid response format");
        }
        const data = rawData;
        clearTimeout(timeoutId);
        const isValid = Boolean(!data.error && data.outAmount && data.routePlan && data.routePlan.length > 0);
        elizaLogger.info(`Quick token validation for ${mintAddress}: ${isValid}`);
        return isValid;
    } catch (error) {
        elizaLogger.warn("Quick token validation error:", error);
        return false;
    }
}

// Configure BigNumber
BigNumber.config({
    EXPONENTIAL_AT: 1e9,
    DECIMAL_PLACES: 20,
});

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
            elizaLogger.warn("Amount too large for safe integer conversion:", rawAmount.toString());
            throw new Error("Amount too large for safe processing");
        }
        elizaLogger.info("Amount conversion:", {
            original: amount,
            decimals: decimals,
            converted: rawAmount.toString(),
        });
        return rawAmount;
    } catch (error) {
        elizaLogger.error("Error converting amount:", error);
        throw error;
    }
}

// -------------------------
// Timeouts & Retry Config
// -------------------------
const SWAP_TIMEOUTS = {
    SECURITY_CHECK: 1000, // 1 second
    QUOTE: 3000,          // 3 seconds
    SWAP: 15000,          // 15 seconds
};

// Quick security check for a token address (skips SOL)
async function quickSecurityCheck(
    tokenCA: string,
): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SWAP_TIMEOUTS.SECURITY_CHECK);
        if (tokenCA === settings.SOL_ADDRESS) {
            clearTimeout(timeoutId);
            return true;
        }
        const response = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${settings.SOL_ADDRESS}&outputMint=${tokenCA}&amount=100000`,
            { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error: unknown) {
        elizaLogger.warn("[Security Check] Skipped:", isErrorWithMessage(error) ? error.message : String(error));
        return true;
    }
}

// Check pool reserves before swap execution
export async function checkPoolReserves(
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number
): Promise<boolean> {
    try {
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
        const response = await fetch(quoteUrl);
        const data = await response.json() as JupiterQuoteResponse;
        if (data.error) {
            elizaLogger.warn("Pool reserve check failed:", data.error);
            return false;
        }
        const priceImpact = data.priceImpactPct ?? 0;
        if (priceImpact > 10) {
            elizaLogger.warn("Price impact too high:", priceImpact);
            return false;
        }
        return true;
    } catch (error) {
        elizaLogger.error("Error checking pool reserves:", error);
        return false;
    }
}

// -------------------------
// Parameter Extraction & Validation
// -------------------------

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
    if (
        !validateTokenAddress(content.inputTokenCA) ||
        (extractedAddresses.input && content.inputTokenCA !== extractedAddresses.input)
    ) {
        content.inputTokenCA = extractedAddresses.input;
        elizaLogger.info("Corrected input token address:", content.inputTokenCA);
    }
    if (
        !validateTokenAddress(content.outputTokenCA) ||
        (extractedAddresses.output && content.outputTokenCA !== extractedAddresses.output)
    ) {
        content.outputTokenCA = extractedAddresses.output;
        elizaLogger.info("Corrected output token address:", content.outputTokenCA);
    }
    if (detectSOLToken(messageText, "input")) {
        content.inputTokenSymbol = "SOL";
        content.inputTokenCA = settings.SOL_ADDRESS;
        elizaLogger.info("Set input token to SOL");
    }
    if (detectSOLToken(messageText, "output")) {
        content.outputTokenSymbol = "SOL";
        content.outputTokenCA = settings.SOL_ADDRESS;
        elizaLogger.info("Set output token to SOL");
    }
    return content;
};

// -------------------------
// Quote & Route Functions
// -------------------------

// Get quote for a route using cached price info when possible
export async function getQuoteForRoute(
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number,
    swapService: SwapService
): Promise<{ price: number; impact: number; minOutput: number }> {
    // Try to get prices from cache first
    const [inputPrice, outputPrice] = await Promise.all([
        swapService.getTokenPrice(inputTokenCA),
        swapService.getTokenPrice(outputTokenCA)
    ]);

    // If we have valid cached prices, use them for initial price calculation
    if (inputPrice.price > 0 && outputPrice.price > 0) {
        const expectedPrice = inputPrice.price / outputPrice.price;
        
        // Still get Jupiter quote for impact calculation
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
        const response = await fetch(url);
        if (response.status === 401) {
            throw new Error("Unauthorized: API key issue. Please check your API key permissions.");
        }
        const data = await response.json() as JupiterQuoteResponse;
        if (!data?.outAmount || !data?.priceImpactPct) {
            throw new Error("Invalid quote response");
        }

        const actualPrice = Number(data.outAmount) / amount;
        const impact = Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
        const minOutput = Number(data.outAmountWithSlippage);

        return { price: actualPrice, impact, minOutput };
    }

    // Fallback to Jupiter quote if cached prices not available
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${amount}&slippageBps=100`;
    const response = await fetch(url);
    if (response.status === 401) {
        throw new Error("Unauthorized: API key issue. Please check your API key permissions.");
    }
    const data = await response.json() as JupiterQuoteResponse;
    if (!data?.outAmount || !data?.priceImpactPct) {
        throw new Error("Invalid quote response");
    }
    const price = Number(data.outAmount) / amount;
    const impact = Number(data.priceImpactPct);
    const minOutput = Number(data.outAmountWithSlippage);
    return { price, impact, minOutput };
}

// Get an optimized quote using Jupiter first, then Raydium, and finally PumpFun as fallback
async function getOptimizedQuote(
    inputTokenCA: string,
    outputTokenCA: string,
    rawAmount: BigNumber
): Promise<{ route: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SWAP_TIMEOUTS.QUOTE);
    try {
        // Try Jupiter route first
        const jupiterQuoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${rawAmount.toString()}&slippageBps=100&onlyDirectRoutes=true&excludeDexes=Pump,Serum,Saber,Aldrin,Crema,Step,Cropper,GooseFX,Lifinity,Meteora,Invariant,Dradex,Openbook`;
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
            return { route: "jupiter" };
        }
        // If Jupiter fails, try Raydium route
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
            return { route: "raydium" };
        }
        throw new Error("No valid quote found");
    } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (isErrorWithMessage(error) && error.name === "AbortError") {
            throw new Error("Quote fetch timed out");
        }
        throw error;
    }
}

// -------------------------
// Token Extraction & Validation Helpers
// -------------------------

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
    if (address === settings.SOL_ADDRESS) return true;
    // Allow standard Solana addresses and PumpFun addresses ending with 'pump'
    return /^[A-HJ-NP-Za-km-z1-9]{43,44}(?:pump)?$/.test(address);
}

function extractTokenAddresses(text: string): { input: string | null; output: string | null } {
    const addresses: string[] = [];
    // Updated pattern to match both standard and PumpFun addresses
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

// Add this function after the other utility functions
async function getTokenInfo(tokenAddress: string): Promise<string | null> {
    try {
        const response = await fetch(`https://token.jup.ag/all`);
        if (!response.ok) return null;

        const rawData = await response.json();
        if (!isTokenApiResponse(rawData)) return null;

        const token = rawData.tokens.find(t => t.address === tokenAddress);
        return token?.symbol ?? null;
    } catch (error) {
        elizaLogger.warn("Error fetching token info:", error);
        return null;
    }
}

// -------------------------
// Swap Action: Execute Swap
// -------------------------

export type Handler = (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
) => Promise<boolean>;

function handleSwapError(error: unknown): string {
    if (isSwapError(error)) {
        return error.error;
    }
    return String(error);
}

export const executeSwap: Action = {
    name: "EXECUTE_SWAP",
    similes: [
        "SWAP_TOKENS",
        "TOKEN_SWAP",
        "MULTIDEX_SWAP",
        "swap * for *",
        "swap * * for *",
        "swap * * * for *",
        "swap tokens",
        "swap for",
        "do swap",
        "execute swap",
        "perform swap",
        "make swap",
        "swap now",
    ],
    description: "Execute a multi-DEX fallback swap (Jupiter → Raydium).",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Swap 0.1 SOL for USDC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "✅ Jupiter swap success! Tx: ...",
                },
            },
        ],
    ] as ActionExample[][],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        if (
            message.userId === runtime.agentId ||
            message.content.isBot === true ||
            message.userId === process.env.DISCORD_APPLICATION_ID ||
            message.content.source === "bot"
        ) {
            return false;
        }
        return message.content.action === "EXECUTE_SWAP";
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const memoryManager = runtime.messageManager as IMemoryManager;
        
        try {
            elizaLogger.info("=== UPDATED swap.ts CODE IS RUNNING (v4) ===");

            // Start transaction
            await memoryManager.beginTransaction();

            const connection = new Connection(
                settings.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta")
            );

            // Initialize SwapService
            const swapService = new SwapService(runtime);

            // Extract parameters using the LLM and validate them
            if (!state) {
                await memoryManager.rollbackTransaction();
                callback?.({ text: "State is required for this operation." });
                return false;
            }
            const context = composeContext({
                state,
                template: swapTemplate,
                templatingEngine: "handlebars"
            });
            const llmResponse = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });
            const content = validateLLMResponse(llmResponse, message.content.text);
            if (!content.inputTokenCA || !content.outputTokenCA) {
                await memoryManager.rollbackTransaction();
                callback?.({ text: "Could not determine token addresses. Please specify valid tokens." });
                return false;
            }
            if (content.amount === null || isNaN(content.amount) || content.amount <= 0) {
                await memoryManager.rollbackTransaction();
                callback?.({ text: "Could not determine the amount to swap. Please specify an amount." });
                return false;
            }

            try {
                // Validate tokens before proceeding
                const [inputValid, outputValid] = await Promise.all([
                    quickTokenValidation(content.inputTokenCA, swapService),
                    quickTokenValidation(content.outputTokenCA, swapService)
                ]);
                
                if (!inputValid || !outputValid) {
                    await memoryManager.rollbackTransaction();
                    callback?.({ text: "One or both tokens are invalid or not available for trading." });
                    return false;
                }

                const rawAmount = await convertAmountToDecimals(connection, content.amount, content.inputTokenCA);
                const quote = await getQuoteForRoute(content.inputTokenCA, content.outputTokenCA, rawAmount.toNumber(), swapService);
                if (quote.impact > 10) {
                    await memoryManager.rollbackTransaction();
                    callback?.({ text: "Price impact too high (>10%). Please try a smaller amount or different tokens." });
                    return false;
                }

                const { keypair } = await getWalletKey(runtime, true);
                if (!keypair) {
                    await memoryManager.rollbackTransaction();
                    throw new Error("Failed to get wallet keypair");
                }

                const swapContext: SwapContext = {
                    swapService,
                    connection,
                    keypair
                };

                const route = await getOptimalSwapRoute(content.inputTokenCA, content.outputTokenCA, rawAmount.toNumber());
                const swapResult = await executeSwapWithRoute(connection, keypair, route, rawAmount.toNumber());

                // Use cached token info when possible
                const [inputTokenInfo, outputTokenInfo] = await Promise.all([
                    swapService.getTokenPrice(content.inputTokenCA),
                    swapService.getTokenPrice(content.outputTokenCA)
                ]);

                const inputDisplay = inputTokenInfo.symbol || content.inputTokenCA;
                const outputDisplay = outputTokenInfo.symbol || content.outputTokenCA;

                // Create Solscan URL
                const solscanUrl = `https://solscan.io/tx/${swapResult.signature}`;

                // Create and store swap memory
                await memoryManager.createMemory({
                    id: stringToUuid(swapResult.signature + "-" + runtime.agentId),
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    roomId: ROOM_IDS.TREASURY,  // Swap records should be in treasury room
                    content: {
                        type: "treasury_transaction",
                        status: "completed",
                        inputToken: inputDisplay,
                        outputToken: outputDisplay,
                        inputAmount: content.amount,
                        outputAmount: swapResult.outputAmount,
                        price: quote.price,
                        priceImpact: quote.impact,
                        timestamp: Date.now(),
                        txHash: swapResult.signature,
                        txSignature: swapResult.signature,
                        source: "discord",
                        text: `Swapped ${content.amount} ${inputDisplay} for ${outputDisplay}`
                    },
                    unique: true
                });

                // Commit transaction
                await memoryManager.commitTransaction();

                const responses = [
                    `🔄 DAO Treasury: Successfully traded ${content.amount} ${inputDisplay} for ${outputDisplay} using our treasury funds. \n\nView on Solscan: ${solscanUrl}`,
                    `✨ DAO Treasury Swap: Exchanged ${content.amount} ${inputDisplay} for ${outputDisplay} at the best rate. \n\nView on Solscan: ${solscanUrl}`,
                    `🏦 Treasury Action: Swapped ${content.amount} ${inputDisplay} for ${outputDisplay} via ${route.bestRoute}. \n\nView on Solscan: ${solscanUrl}`
                ];
                callback?.({
                    text: responses[Math.floor(Math.random() * responses.length)],
                });
                return true;
            } catch (error) {
                await memoryManager.rollbackTransaction();
                elizaLogger.error("Swap execution error:", error);
                callback?.({
                    text: `Failed to execute swap: ${error instanceof Error ? error.message : String(error)}`
                });
                return false;
            }
        } catch (error) {
            await memoryManager.rollbackTransaction();
            elizaLogger.error("Swap handler error:", error);
            callback?.({
                text: "An unexpected error occurred while processing your swap request."
            });
            return false;
        }
    },
};

// -------------------------
// Fallback Quote & Route Functions
// -------------------------

// getOptimalSwapRoute tries Jupiter first, then Raydium, then PumpFun
export async function getOptimalSwapRoute(
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number
): Promise<{ inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: "jupiter" | "raydium" | "pumpfun" }> {
    try {
        await getQuoteForRoute(inputTokenCA, outputTokenCA, amount, new SwapService(null));
        return {
            inputMint: inputTokenCA,
            outputMint: outputTokenCA,
            isPumpFunToken: false,
            bestRoute: "jupiter",
        };
    } catch (jupiterError) {
        elizaLogger.error(`Jupiter error: ${handleSwapError(jupiterError)}`);
        try {
            const response = await fetch("https://api.raydium.io/v2/main/quote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    amount: amount.toString(),
                }),
            });
            if (response.ok) {
                return {
                    inputMint: inputTokenCA,
                    outputMint: outputTokenCA,
                    isPumpFunToken: false,
                    bestRoute: "raydium",
                };
            }
        } catch (raydiumError: unknown) {
            elizaLogger.warn("Raydium quote failed:", isErrorWithMessage(raydiumError) ? raydiumError.message : String(raydiumError));
            try {
                const response = await fetch(`https://pumpportal.fun/api/pool/${outputTokenCA}`);
                if (response.ok) {
                    return {
                        inputMint: inputTokenCA,
                        outputMint: outputTokenCA,
                        isPumpFunToken: true,
                        bestRoute: "pumpfun",
                    };
                }
            } catch (pumpfunError: unknown) {
                elizaLogger.warn("PumpFun quote failed:", isErrorWithMessage(pumpfunError) ? pumpfunError.message : String(pumpfunError));
            }
        }
    }
    throw new Error("No valid route found for swap");
}

// executeSwapWithRoute handles the swap execution for a given route
export async function executeSwapWithRoute(
    connection: Connection,
    keypair: Keypair,
    route: { inputMint: string; outputMint: string; isPumpFunToken: boolean; bestRoute: string },
    amount: number
): Promise<{ signature: string; inputAmount: number; outputAmount: number; swapTxBase64: string }> {
    const result = await (async () => {
        switch (route.bestRoute) {
            case "jupiter":
                return await jupiterSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            case "raydium":
                return await raydiumSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            case "pumpfun":
                return await pumpFunSwap(connection, keypair, route.inputMint, route.outputMint, amount);
            default:
                throw new Error(`Unknown route type: ${route.bestRoute}`);
        }
    })();
    return {
        ...result,
        swapTxBase64: "", // Signing is handled internally
    };
}
