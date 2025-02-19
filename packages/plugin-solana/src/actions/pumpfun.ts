// pumpfun.ts
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { generateImage, elizaLogger } from "@elizaos/core";
import { Connection, PublicKey, VersionedTransaction, Keypair } from "@solana/web3.js";
import { CreateTokenMetadata, PriorityFee, PumpFunSDK } from "pumpdotfun-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  settings,
  Content,
  type Action,
} from "@elizaos/core";


import * as fs from "fs";
import * as path from "path";
import { getWalletKey } from "../keypairUtils.js";
import FormData from "form-data";

// --- Interfaces for token metadata and content ---
interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image_description: string;
}

interface CreateTokenContent extends Content {
  tokenMetadata: TokenMetadata;
  buyAmountSol: number;
  requiredLiquidity: number;
}

export interface CreateAndBuyContent extends Content {
  tokenMetadata: {
    name: string;
    symbol: string;
    description: string;
    image_description: string;
    filePath: string;
    twitter?: string;
    telegram?: string;
    website?: string;
  };
  buyAmountSol: string | number;
  text: string;
  type: string;
  action: string;
}

export function isCreateAndBuyContent(
  content: any
): content is CreateAndBuyContent {
  elizaLogger.log("Content for create & buy", content);
  return (
    typeof content.tokenMetadata === "object" &&
    content.tokenMetadata !== null &&
    typeof content.tokenMetadata.name === "string" &&
    typeof content.tokenMetadata.symbol === "string" &&
    typeof content.tokenMetadata.description === "string" &&
    typeof content.tokenMetadata.image_description === "string" &&
    typeof content.tokenMetadata.filePath === "string" &&
    (typeof content.buyAmountSol === "string" ||
      typeof content.buyAmountSol === "number") &&
    typeof content.text === "string" &&
    typeof content.type === "string" &&
    typeof content.action === "string"
  );
}


// Extend CreateTokenMetadata to include a file (for local reference) and ensure we have the URI.
interface ExtendedTokenMetadata extends Omit<CreateTokenMetadata, "file"> {
  uri: string;
  file: Blob;
}

interface IpfsResponse {
    metadataUri: string;
}

// --- The createAndBuyToken function ---
// This function first uploads the token metadata (including the generated image)
// to the pump.fun IPFS endpoint. It then calls the token creation API including the returned URI.
export const createAndBuyToken = async ({
  deployer,
  mint,
  tokenMetadata,
  allowOffCurve,
  connection,
}: {
  deployer: Keypair;
  mint: Keypair;
  tokenMetadata: ExtendedTokenMetadata; // Now requires a URI field.
  buyAmountSol: bigint;
  priorityFee: PriorityFee;
  allowOffCurve: boolean;
  commitment?:
    | "processed"
    | "confirmed"
    | "finalized"
    | "recent"
    | "single"
    | "singleGossip"
    | "root"
    | "max";
  sdk: PumpFunSDK;
  connection: Connection;
  slippage: string;
}) => {
  try {
    elizaLogger.log("[CREATE_TOKEN] Creating token:", {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      description: tokenMetadata.description,
    });

    // Check deployer balance – require at least 100,000,000 lamports.
    const deployerBalance = await connection.getBalance(deployer.publicKey);
    if (deployerBalance < 100_000_000) {
      throw new Error(
        `Deployer has insufficient SOL: ${deployerBalance} lamports. Need at least 100,000,000 lamports.`
      );
    }

    // Call the token creation endpoint.
    const creationResponse = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: deployer.publicKey.toBase58(),
        action: "create",
        mint: mint.publicKey.toBase58(), // Use the public key here.
        tokenMetadata: {
          name: tokenMetadata.name,
          symbol: tokenMetadata.symbol,
          description: tokenMetadata.description,
          uri: tokenMetadata.uri, // Metadata URI from IPFS.
        },
        denominatedInSol: "true",
        amount: 0.1, // Initial liquidity in SOL.
        slippage: 10, // Direct percentage.
        priorityFee: 0.0005,
        pool: "pump",
      }),
    });

    if (!creationResponse.ok) {
      const errorText = await creationResponse.text();
      elizaLogger.error("[CREATE_TOKEN] Creation failed:", {
        status: creationResponse.status,
        statusText: creationResponse.statusText,
        error: errorText,
      });
      throw new Error(`Failed to create token: ${creationResponse.statusText}. Details: ${errorText}`);
    }

    // Get and deserialize the transaction.
    const txData = await creationResponse.arrayBuffer();
    elizaLogger.log("[CREATE_TOKEN] Received transaction data, size:", txData.byteLength);

    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));

    // Update the recent blockhash.
    const { blockhash } = await connection.getLatestBlockhash();
    tx.message.recentBlockhash = blockhash;

    // Sign with both deployer and mint.
    tx.sign([deployer, mint]);

    const signature = await connection.sendTransaction(tx);
    elizaLogger.log("[CREATE_TOKEN] Transaction sent:", signature);

    // Confirm the transaction.
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...latestBlockhash,
    });

    elizaLogger.log("[CREATE_TOKEN] Token created successfully:", {
      signature,
      mint: mint.publicKey.toBase58(),
      url: `https://pump.fun/token/${mint.publicKey.toBase58()}`,
    });

    // Check the token balance.
    const ata = getAssociatedTokenAddressSync(mint.publicKey, deployer.publicKey, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    const amount = balance.value.uiAmount;

    if (amount === null) {
      elizaLogger.log(`${deployer.publicKey.toBase58()}:`, "No Account Found");
    } else {
      elizaLogger.log(`${deployer.publicKey.toBase58()}:`, amount);
    }

    return {
      success: true,
      ca: mint.publicKey.toBase58(),
      creator: deployer.publicKey.toBase58(),
      signature,
    };
  } catch (error) {
    elizaLogger.error("[CREATE_TOKEN] Error:", error);
    return {
      success: false,
      ca: mint.publicKey.toBase58(),
      error: (error as Error).message || "Transaction failed",
    };
  }
};

// --- Buy functions (unchanged) ---
export const buyPumpToken = async ({
  buyer,
  mint,
  amountSol,
  connection,
}: {
  buyer: Keypair;
  mint: PublicKey;
  amountSol: number;
  connection: Connection;
}) => {
  try {
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: buyer.publicKey.toBase58(),
        action: "buy",
        mint: mint.toBase58(),
        denominatedInSol: "true",
        amount: amountSol,
        slippage: 10,
        priorityFee: 0.0005,
        pool: "pump",
      }),
    });
    if (response.status === 200) {
      const data = await response.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(data));
      tx.sign([buyer]);
      const signature = await connection.sendTransaction(tx);
      elizaLogger.log("Buy transaction successful:", {
        signature,
        url: `https://solscan.io/tx/${signature}`,
      });
      return { success: true, signature, url: `https://solscan.io/tx/${signature}` };
    } else {
      const errorText = await response.text();
      throw new Error(`Failed to create buy transaction: ${response.statusText}. Details: ${errorText}`);
    }
  } catch (error) {
    elizaLogger.error("Buy failed:", error);
    return { success: false, error: (error as Error).message || "Transaction failed" };
  }
};

export const buyToken = async ({
  buyer,
  mint,
  amount,
  allowOffCurve,
  connection,
}: {
  sdk: PumpFunSDK;
  buyer: Keypair;
  mint: PublicKey;
  amount: bigint;
  priorityFee: PriorityFee;
  allowOffCurve: boolean;
  slippage: string;
  connection: Connection;
}) => {
  const amountSol = Number(amount) / 1e9;
  const result = await buyPumpToken({ buyer, mint, amountSol, connection });
  if (result.success) {
    elizaLogger.log("Success:", `https://pump.fun/${mint.toBase58()}`);
    const ata = getAssociatedTokenAddressSync(mint, buyer.publicKey, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    const tokenAmount = balance.value.uiAmount;
    if (tokenAmount === null) {
      elizaLogger.log(`${buyer.publicKey.toBase58()}:`, "No Account Found");
    } else {
      elizaLogger.log(`${buyer.publicKey.toBase58()}:`, tokenAmount);
    }
  } else {
    elizaLogger.log("Buy failed:", result.error);
  }
};

export const sellToken = async ({
  sdk,
  seller,
  mint,
  amount,
  priorityFee,
  allowOffCurve,
  slippage,
  connection,
}: {
  sdk: PumpFunSDK;
  seller: Keypair;
  mint: PublicKey;
  amount: bigint;
  priorityFee: PriorityFee;
  allowOffCurve: boolean;
  slippage: string;
  connection: Connection;
}) => {
  const sellResults = await sdk.sell(seller as any, mint, amount, BigInt(slippage), priorityFee);
  if (sellResults.success) {
    elizaLogger.log("Success:", `https://pump.fun/${mint.toBase58()}`);
    const ata = getAssociatedTokenAddressSync(mint, seller.publicKey, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    const tokenAmount = balance.value.uiAmount;
    if (tokenAmount === null) {
      elizaLogger.log(`${seller.publicKey.toBase58()}:`, "No Account Found");
    } else {
      elizaLogger.log(`${seller.publicKey.toBase58()}:`, tokenAmount);
    }
  } else {
    elizaLogger.log("Sell failed");
  }
};

export const createPumpFunToken: Action = {
  name: "CREATE_TOKEN",
  similes: ["CREATE_MEMECOIN", "MAKE_TOKEN", "LAUNCH_TOKEN"],
  description: "Create a new PumpFun memecoin token",
  validate: async (_runtime, message) => {
    const text = message.content.text?.toLowerCase().trim() || "";
    return (
      text.startsWith("create") &&
      (text.includes("memecoin") || text.includes("token")) &&
      text.includes("called")
    );
  },
  handler: async (runtime, message, _state, _options, callback) => {
    try {
      // --- Extract token name and symbol from the message ---
      const text = message.content.text;
      const nameMatch = text.toLowerCase().match(/called\s+([^\.]+)(?:\.|$)/i);
      if (!nameMatch) {
        callback?.({
          text: "Please specify the token name after 'called', e.g., 'create a memecoin called Based VKay'",
        });
        return false;
      }
      const tokenName = nameMatch[1].trim();
      const tokenSymbol = tokenName.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6);
      callback?.({ text: `Creating ${tokenName} (${tokenSymbol}) on pump.fun...` });

      // --- Create default token metadata if not provided ---
      const content = message.content as CreateTokenContent;
      const tokenMetadata =
        content.tokenMetadata || {
          name: tokenName,
          symbol: tokenSymbol,
          description: `${tokenName} - A community-driven memecoin launched on pump.fun`,
          image_description: `Create a modern, minimalist logo for ${tokenName} cryptocurrency. The design should be clean and professional, suitable for a memecoin.`,
        };

      // --- Generate the token image ---
      const imageResult = await generateImage(
        {
          prompt:
            tokenMetadata.image_description ||
            `logo for ${tokenMetadata.name} (${tokenMetadata.symbol}) token - ${tokenMetadata.description}`,
          width: 256,
          height: 256,
          count: 1,
        },
        runtime
      );
      elizaLogger.log("[CREATE_TOKEN] Image generation result:", imageResult);
      if (!imageResult?.data?.[0]) {
        elizaLogger.error("[CREATE_TOKEN] Failed to generate image:", imageResult);
        callback?.({ text: "Failed to generate token image. Please try again." });
        return false;
      }
      // --- Convert base64 image to a Buffer ---
      const base64Data = imageResult.data[0].split(",")[1];
      elizaLogger.log("[CREATE_TOKEN] Base64 data length:", base64Data?.length || 0);
      const imageBuffer = Buffer.from(base64Data, "base64");
      elizaLogger.log("[CREATE_TOKEN] Image buffer size:", imageBuffer.length);
      // --- Save the image to a temporary file ---
      const tempDir = path.join(process.cwd(), "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const imagePath = path.join(tempDir, `${tokenSymbol.toLowerCase()}_${Date.now()}.png`);
      fs.writeFileSync(imagePath, imageBuffer);

      // --- Setup SDK and connection ---
      const connection = new Connection(settings.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
      const { keypair } = await getWalletKey(runtime, true);
      if (!keypair) {
          throw new Error("Failed to get wallet keypair");
      }
      const wallet = new Wallet(keypair as any);
      const provider = new AnchorProvider(connection as any, wallet, {
        commitment: "confirmed",
        preflightCommitment: "processed",
      });
      const sdk = new PumpFunSDK(provider);
      // --- Generate a new mint keypair ---
      const mintKeypair = Keypair.generate();
      elizaLogger.log(`Generated mint address: ${mintKeypair.publicKey.toBase58()}`);

      try {
        // --- Upload metadata to IPFS ---
        const form = new FormData();
        form.append("file", Buffer.from(imageBuffer), {
          filename: `${tokenMetadata.name}.png`,
          contentType: "image/png",
        });
        form.append("name", tokenMetadata.name);
        form.append("symbol", tokenMetadata.symbol);
        form.append("description", tokenMetadata.description);
        form.append("showName", "true");

        elizaLogger.log("[CREATE_TOKEN] Uploading metadata to IPFS with file:", {
          name: tokenMetadata.name,
          symbol: tokenMetadata.symbol,
          fileSize: imageBuffer.length,
        });

        const ipfsResponse = await fetch("https://pump.fun/api/ipfs", {
          method: "POST",
          body: form.getBuffer(),
          headers: {
            ...form.getHeaders(),
            Accept: "application/json",
          },
        });
        if (!ipfsResponse.ok) {
          const errorText = await ipfsResponse.text();
          throw new Error(`IPFS metadata creation failed: ${ipfsResponse.statusText}. Details: ${errorText}`);
        }
        const ipfsData = await ipfsResponse.json() as IpfsResponse;
        elizaLogger.log("[CREATE_TOKEN] IPFS metadata created:", ipfsData);
        const metadataUri = ipfsData.metadataUri;
        if (!metadataUri) {
          throw new Error("No metadata URI returned from IPFS upload");
        }
        // --- Build full token metadata including the URI ---
        const fullTokenMetadata: ExtendedTokenMetadata = {
          name: tokenMetadata.name,
          symbol: tokenMetadata.symbol,
          description: tokenMetadata.description,
          uri: metadataUri,
          file: new Blob([imageBuffer], { type: "image/png" }),
        };
        // --- Set priority fee and initial liquidity ---
        const priorityFee = {
          unitLimit: 100_000_000,
          unitPrice: 100_000,
        };
        const initialLiquidity = BigInt(0.1 * 1e9);
        callback?.({ text: `Preparing token metadata and initializing creation...` });
        // --- Create token and add initial liquidity ---
        const result = await createAndBuyToken({
          deployer: keypair,
          mint: mintKeypair,
          tokenMetadata: fullTokenMetadata,
          buyAmountSol: initialLiquidity,
          priorityFee,
          allowOffCurve: false,
          sdk,
          connection,
          slippage: "2000",
        });
        if (result.success) {
          const pumpFunUrl = `https://pump.fun/${result.ca}`;
          callback?.({
            text: `✅ Successfully created ${tokenName} (${tokenSymbol})!\n\n` +
              `Contract Address: \`${result.ca}\`\n` +
              `Creator Address: \`${result.creator}\`\n` +
              `Pump.fun URL: ${pumpFunUrl}\n\n` +
              `Initial liquidity of 0.1 SOL has been added.`,
          });
          return true;
        } else {
          throw new Error(result.error?.toString() || "Transaction failed");
        }
      } catch (error) {
        elizaLogger.error("[CREATE_TOKEN] Error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        callback?.({
          text: `Failed to create token: ${errorMessage}\n\nPlease try again in a few minutes. If the issue persists, the pump.fun API may be experiencing issues.`,
        });
        return false;
      }
    } catch (error) {
      elizaLogger.error("[CREATE_TOKEN] Error:", error);
      callback?.({
        text: `Failed to create token: ${(error as Error).message || "Unknown error"}`,
      });
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "create a memecoin called Based VKay" },
      },
      {
        user: "{{agentName}}",
        content: {
          text: "Creating Based VKay (BVKAY) on pump.fun...",
          type: "command",
          action: "CREATE_TOKEN",
        },
      },
    ],
  ],
};

export const actions = [createPumpFunToken];
