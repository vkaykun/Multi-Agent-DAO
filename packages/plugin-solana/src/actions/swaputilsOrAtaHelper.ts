// swapUtilsOrAtaHelper.ts

import {
    elizaLogger,
    settings,
    IAgentRuntime
  } from "@elizaos/core";
  
  import {
    Connection,
    PublicKey,
    VersionedTransaction,
    Keypair,
    Transaction,
    LAMPORTS_PER_SOL
  } from "@solana/web3.js";
  
  import {
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  } from "@solana/spl-token";
  
  import { getWalletKey } from "../keypairUtils.js";
  
  interface JupiterSwapResponse {
    swapTransaction: string;
  }
  
  interface JupiterQuoteResponse {
    error?: string;
    outAmount: string;
    outputDecimals: number;
  }
  
  /**
   * Utility function to ensure an Associated Token Account exists for a given mint
   */
  export async function ensureATAExists(
    connection: Connection,
    userKeypair: Keypair,
    mintAddress: string
  ): Promise<void> {
    try {
      if (!mintAddress || mintAddress === settings.SOL_ADDRESS) {
        return;
      }
  
      const mintPubkey = new PublicKey(mintAddress);
      const ataAddress = await getAssociatedTokenAddress(
        mintPubkey,
        userKeypair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      const ataInfo = await connection.getAccountInfo(ataAddress);
      if (ataInfo) {
        elizaLogger.log("[ensureATAExists] ATA already exists:", mintAddress);
        return;
      }
  
      elizaLogger.log("[ensureATAExists] Creating ATA for:", mintAddress);
      const blockhashObj = await connection.getLatestBlockhash();
      const transaction = new Transaction({
        recentBlockhash: blockhashObj.blockhash,
        feePayer: userKeypair.publicKey,
      });
  
      const createIx = createAssociatedTokenAccountInstruction(
        userKeypair.publicKey,
        ataAddress,
        userKeypair.publicKey,
        mintPubkey,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      transaction.add(createIx);
  
      const signature = await connection.sendTransaction(transaction, [userKeypair]);
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
      elizaLogger.log("[ensureATAExists] ATA creation sig:", signature);
  
    } catch (err) {
      elizaLogger.error("[ensureATAExists] error:", err);
    }
  }
  
  export async function getTokenDecimals(
    connection: Connection,
    mintAddress: string
  ): Promise<number> {
    const mintPublicKey = new PublicKey(mintAddress);
    const tokenAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);
  
    if (
      tokenAccountInfo.value &&
      typeof tokenAccountInfo.value.data === "object" &&
      "parsed" in tokenAccountInfo.value.data
    ) {
      const parsedInfo = tokenAccountInfo.value.data.parsed?.info;
      if (parsedInfo && typeof parsedInfo.decimals === "number") {
        return parsedInfo.decimals;
      }
    }
  
    throw new Error("Unable to fetch token decimals");
  }
  
  export async function readAgentBalanceForToken(
    runtime: IAgentRuntime,
    tokenAddress: string
  ): Promise<number> {
    try {
      const connection = new Connection(settings.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
      const { keypair } = await getWalletKey(runtime, true);
      if (!keypair) {
        throw new Error("Failed to get wallet keypair");
      }
  
      // If it's SOL, read the direct SOL balance
      if (tokenAddress === settings.SOL_ADDRESS) {
        const lamports = await connection.getBalance(keypair.publicKey);
        // Keep a 0.01 SOL buffer for fees
        const net = lamports / LAMPORTS_PER_SOL - 0.01;
        return net > 0 ? net : 0;
      }
  
      // For other tokens, get the associated token account
      const tokenMint = new PublicKey(tokenAddress);
      const ata = await getAssociatedTokenAddress(
        tokenMint,
        keypair.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
  
      try {
        const tokenAccountInfo = await connection.getTokenAccountBalance(ata);
        return Number(tokenAccountInfo.value.amount);
      } catch (error) {
        // If the token account doesn't exist, return 0
        return 0;
      }
    } catch (error) {
      elizaLogger.error("[READ_BALANCE] Error:", error);
      return 0;
    }
  }
  
  export async function jupiterSwap(
    connection: Connection,
    walletKeypair: Keypair,
    inputTokenCA: string,
    outputTokenCA: string,
    inputAmount: number
  ): Promise<{
    signature: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
  }> {
    try {
      // Ensure we have ATAs for both tokens (if not SOL)
      if (outputTokenCA !== settings.SOL_ADDRESS) {
        await ensureATAExists(connection, walletKeypair, outputTokenCA);
      }
      if (inputTokenCA !== settings.SOL_ADDRESS) {
        await ensureATAExists(connection, walletKeypair, inputTokenCA);
      }
  
      // Get quote from Jupiter
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${inputAmount}&slippageBps=100`;
      elizaLogger.info("Fetching Jupiter quote:", quoteUrl);
      const quoteResponse = await fetch(quoteUrl);
      const quoteData = await quoteResponse.json() as JupiterQuoteResponse;
  
      if (quoteData.error) {
        throw new Error(`Jupiter quote error: ${quoteData.error}`);
      }
  
      // Get serialized transactions for the swap
      const swapResponse = await (await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: walletKeypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: 2000000,
          dynamicComputeUnitLimit: true
        })
      })).json();
  
      if (!swapResponse || typeof (swapResponse as JupiterSwapResponse).swapTransaction !== 'string') {
        throw new Error('Invalid swap response');
      }
  
      const { swapTransaction } = swapResponse as JupiterSwapResponse;
  
      // Deserialize and sign the transaction
      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  
      // Get latest blockhash before sending
      const latestBlockhash = await connection.getLatestBlockhash('finalized');
      transaction.message.recentBlockhash = latestBlockhash.blockhash;
      transaction.sign([walletKeypair]);
  
      // Send the transaction
      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'finalized',
        maxRetries: 3
      });
      elizaLogger.info("Jupiter swap signature:", signature);
  
      // Wait for confirmation using same blockhash
      await connection.confirmTransaction({
        signature,
        ...latestBlockhash
      }, 'finalized');
  
      // Calculate output amount and entry price
      const outputAmount = Number(quoteData.outAmount) / Math.pow(10, quoteData.outputDecimals);
      const entryPrice = inputAmount / outputAmount;
  
      return {
        signature,
        inputAmount,
        outputAmount,
        entryPrice
      };
    } catch (error) {
      elizaLogger.error("Jupiter swap error:", error);
      throw error;
    }
  }
  
  export async function raydiumSwap(
    _connection: Connection,
    _walletKeypair: Keypair,
    _inputTokenCA: string,
    _outputTokenCA: string,
    _inputAmount: number
  ): Promise<{
    signature: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
  }> {
    // Implementation similar to jupiterSwap but using Raydium's API
    throw new Error("Raydium swap not implemented");
  }
  
  export async function pumpFunSwap(
    _connection: Connection,
    _walletKeypair: Keypair,
    _inputTokenCA: string,
    _outputTokenCA: string,
    _inputAmount: number
  ): Promise<{
    signature: string;
    inputAmount: number;
    outputAmount: number;
    entryPrice: number;
  }> {
    // Implementation similar to jupiterSwap but using PumpFun's API
    throw new Error("PumpFun swap not implemented");
  }
  