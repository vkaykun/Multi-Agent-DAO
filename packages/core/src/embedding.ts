import { getEmbeddingModelSettings, getEndpoint } from "./models.ts";
import { type IAgentRuntime, ModelProviderName } from "./types.ts";
import settings from "./settings.ts";
import elizaLogger from "./logger.ts";
import LocalEmbeddingModelManager from "./localembeddingManager.ts";

// Global control to disable embeddings system-wide
const DISABLE_EMBEDDINGS = process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";

interface EmbeddingOptions {
    model: string;
    endpoint: string;
    apiKey?: string;
    length?: number;
    isOllama?: boolean;
    dimensions?: number;
    provider?: EmbeddingProviderType;
    fallbackToZeroVector?: boolean;
}

export const EmbeddingProvider = {
    OpenAI: "OpenAI",
    Ollama: "Ollama",
    GaiaNet: "GaiaNet",
    Heurist: "Heurist",
    BGE: "BGE",
} as const;

export type EmbeddingProviderType =
    (typeof EmbeddingProvider)[keyof typeof EmbeddingProvider];

export type EmbeddingConfig = {
    readonly dimensions: number;
    readonly model: string;
    readonly provider: EmbeddingProviderType;
};

export const getEmbeddingConfig = (): EmbeddingConfig => ({
    dimensions:
        settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
            ? getEmbeddingModelSettings(ModelProviderName.OPENAI).dimensions
            : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
              ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).dimensions
              : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.GAIANET)
                      .dimensions
                : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.HEURIST)
                        .dimensions
                  : 384, // BGE
    model:
        settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
            ? getEmbeddingModelSettings(ModelProviderName.OPENAI).name
            : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
              ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).name
              : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.GAIANET).name
                : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.HEURIST).name
                  : "BGE-small-en-v1.5",
    provider:
        settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
            ? "OpenAI"
            : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
              ? "Ollama"
              : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                ? "GaiaNet"
                : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                  ? "Heurist"
                  : "BGE",
});

async function getRemoteEmbedding(
    input: string,
    options: EmbeddingOptions
): Promise<number[]> {
    // Ensure endpoint ends with /v1 for OpenAI
    const baseEndpoint = options.endpoint.endsWith("/v1")
        ? options.endpoint
        : `${options.endpoint}${options.isOllama ? "/v1" : ""}`;

    // Construct full URL
    const fullUrl = `${baseEndpoint}/embeddings`;

    // Only include dimensions for non-OpenAI endpoints
    const isOpenAI = options.provider === EmbeddingProvider.OpenAI || 
                     options.endpoint.includes('openai.com');

    const requestBody = {
        input,
        model: options.model,
        ...(isOpenAI ? {} : {
            dimensions: options.dimensions || 
                       options.length || 
                       getEmbeddingConfig().dimensions
        })
    };

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options.apiKey
                ? {
                      Authorization: `Bearer ${options.apiKey}`,
                  }
                : {}),
        },
        body: JSON.stringify(requestBody),
    };

    // Log the request body for debugging
    elizaLogger.debug("Embedding request body:", {
        url: fullUrl,
        body: requestBody,
        isOpenAI
    });

    // Retry configuration
    const MAX_RETRIES = 3;
    const INITIAL_RETRY_DELAY = 1000; // 1 second

    // Implement retry loop with exponential backoff
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(fullUrl, requestOptions);

            // Handle rate limiting specifically
            if (response.status === 429) {
                const retryAfterHeader = response.headers.get('retry-after');
                const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : INITIAL_RETRY_DELAY * Math.pow(2, attempt);
                
                elizaLogger.warn(`Rate limit hit in embedding request (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${retryAfter}ms`, {
                    retryAfter,
                    attempt: attempt + 1,
                    maxRetries: MAX_RETRIES
                });
                
                // Wait for the specified time
                await new Promise(resolve => setTimeout(resolve, retryAfter));
                continue; // Skip to next retry
            }

            if (!response.ok) {
                const errorText = await response.text();
                elizaLogger.error("API Response:", errorText);
                
                // If we get a 5XX error or other temporary issue, retry
                if (response.status >= 500 || response.status === 429) {
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
                    elizaLogger.warn(`Temporary error in embedding request (attempt ${attempt + 1}/${MAX_RETRIES}), retrying after ${retryDelay}ms`, {
                        status: response.status,
                        attempt: attempt + 1,
                        maxRetries: MAX_RETRIES
                    });
                    
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue; // Skip to next retry
                }
                
                // For other errors, throw immediately
                throw new Error(
                    `Embedding API Error: ${response.status} ${response.statusText}`
                );
            }

            interface EmbeddingResponse {
                data: Array<{ embedding: number[] }>;
            }

            const data: EmbeddingResponse = await response.json();
            
            // Validate the response
            const embedding = data?.data?.[0]?.embedding;
            if (!Array.isArray(embedding)) {
                throw new Error("Invalid embedding response format");
            }

            return embedding;
        } catch (e) {
            lastError = e as Error;
            elizaLogger.error(`Embedding error (attempt ${attempt + 1}/${MAX_RETRIES}):`, {
                error: e instanceof Error ? e.message : 'Unknown error',
                attempt: attempt + 1,
                maxRetries: MAX_RETRIES
            });
            
            // If this is not the last attempt, wait and retry
            if (attempt < MAX_RETRIES - 1) {
                const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    // If we get here, all retries failed
    elizaLogger.error("All embedding retries failed:", lastError);
    
    // As a last resort, return a zero vector instead of completely failing
    if (options.fallbackToZeroVector) {
        elizaLogger.warn("Falling back to zero vector for embedding");
        return getEmbeddingZeroVector();
    }
    
    // If fallback is not enabled, throw the last error
    throw lastError || new Error("Failed to get embedding after multiple retries");
}

export function getEmbeddingType(runtime: IAgentRuntime): "local" | "remote" {
    const isNode =
        typeof process !== "undefined" &&
        process.versions != null &&
        process.versions.node != null;

    // Use local embedding if:
    // - Running in Node.js
    // - Not using OpenAI provider
    // - Not forcing OpenAI embeddings
    const isLocal =
        isNode &&
        runtime.character.modelProvider !== ModelProviderName.OPENAI &&
        runtime.character.modelProvider !== ModelProviderName.GAIANET &&
        runtime.character.modelProvider !== ModelProviderName.HEURIST &&
        !settings.USE_OPENAI_EMBEDDING;

    return isLocal ? "local" : "remote";
}

export function getEmbeddingZeroVector(): number[] {
    // Use 1536-dimension vectors to match text-embedding-ada-002 embeddings
    // This ensures compatibility with the current system configuration
    return Array(1536).fill(0);
}

/**
 * Gets embeddings from a remote API endpoint.  Falls back to local BGE/384
 *
 * @param {string} input - The text to generate embeddings for
 * @param {EmbeddingOptions} options - Configuration options including:
 *   - model: The model name to use
 *   - endpoint: Base API endpoint URL
 *   - apiKey: Optional API key for authentication
 *   - isOllama: Whether this is an Ollama endpoint
 *   - dimensions: Desired embedding dimensions
 * @param {IAgentRuntime} runtime - The agent runtime context
 * @returns {Promise<number[]>} Array of embedding values
 * @throws {Error} If the API request fails
 */

export async function embed(runtime: IAgentRuntime, input: string) {
    // If embeddings are disabled, immediately return a zero vector without any processing
    if (DISABLE_EMBEDDINGS) {
        const zeroVector = getEmbeddingZeroVector();
        elizaLogger.debug("Embeddings disabled, returning zero vector", {
            input: input?.slice(0, 50) + "...",
            zeroVectorSize: zeroVector.length,
            dimensions: 1536 // Updated to reflect the actual dimensions
        });
        return zeroVector;
    }
    
    elizaLogger.debug("Embedding request:", {
        modelProvider: runtime.character.modelProvider,
        useOpenAI: process.env.USE_OPENAI_EMBEDDING,
        input: input?.slice(0, 50) + "...",
        inputType: typeof input,
        inputLength: input?.length,
        isString: typeof input === "string",
        isEmpty: !input,
    });

    // Validate input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
        elizaLogger.warn("Invalid embedding input:", {
            input,
            type: typeof input,
            length: input?.length,
        });
        return getEmbeddingZeroVector(); // Return zero vector instead of empty array
    }

    // Check cache first
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) {
        if (!Array.isArray(cachedEmbedding) || cachedEmbedding.length !== 1536) {
            elizaLogger.warn("Invalid cached embedding dimension:", {
                isArray: Array.isArray(cachedEmbedding),
                length: Array.isArray(cachedEmbedding) ? cachedEmbedding.length : 'not an array'
            });
            return getEmbeddingZeroVector();
        }
        return cachedEmbedding;
    }

    const config = getEmbeddingConfig();
    const isNode = typeof process !== "undefined" && process.versions?.node;

    // Force OpenAI embeddings if USE_OPENAI_EMBEDDING is true
    if (settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true") {
        const embedding = await getRemoteEmbedding(input, {
            model: "text-embedding-ada-002", // Force OpenAI model
            endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
            apiKey: settings.OPENAI_API_KEY,
            provider: EmbeddingProvider.OpenAI,
            dimensions: 1536, // Force OpenAI dimensions
            fallbackToZeroVector: true // Enable fallback to prevent crashes
        });
        
        if (!Array.isArray(embedding) || embedding.length !== 1536) {
            elizaLogger.error("Invalid OpenAI embedding dimension:", {
                isArray: Array.isArray(embedding),
                length: Array.isArray(embedding) ? embedding.length : 'not an array'
            });
            return getEmbeddingZeroVector();
        }
        return embedding;
    }

    // Determine which embedding path to use
    if (config.provider === EmbeddingProvider.OpenAI) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
            apiKey: settings.OPENAI_API_KEY,
            provider: EmbeddingProvider.OpenAI,
            dimensions: config.dimensions,
            fallbackToZeroVector: true
        });
    }

    if (config.provider === EmbeddingProvider.Ollama) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                getEndpoint(ModelProviderName.OLLAMA),
            isOllama: true,
            provider: EmbeddingProvider.Ollama,
            dimensions: config.dimensions,
            fallbackToZeroVector: true
        });
    }

    if (config.provider == EmbeddingProvider.GaiaNet) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                getEndpoint(ModelProviderName.GAIANET) ||
                settings.SMALL_GAIANET_SERVER_URL ||
                settings.MEDIUM_GAIANET_SERVER_URL ||
                settings.LARGE_GAIANET_SERVER_URL,
            apiKey: settings.GAIANET_API_KEY || runtime.token,
            provider: EmbeddingProvider.GaiaNet,
            dimensions: config.dimensions,
            fallbackToZeroVector: true
        });
    }

    if (config.provider === EmbeddingProvider.Heurist) {
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint: getEndpoint(ModelProviderName.HEURIST),
            apiKey: runtime.token,
            provider: EmbeddingProvider.Heurist,
            dimensions: config.dimensions,
            fallbackToZeroVector: true
        });
    }

    // BGE - try local first if in Node
    if (isNode) {
        try {
            return await getLocalEmbedding(input);
        } catch (error) {
            elizaLogger.warn(
                "Local embedding failed, falling back to remote",
                error
            );
        }
    }

    // Fallback to remote override
    return await getRemoteEmbedding(input, {
        model: config.model,
        endpoint:
            runtime.character.modelEndpointOverride ||
            getEndpoint(runtime.character.modelProvider),
        apiKey: runtime.token,
        provider: config.provider,
        dimensions: config.dimensions,
        fallbackToZeroVector: true
    });

    async function getLocalEmbedding(input: string): Promise<number[]> {
        elizaLogger.debug("DEBUG - Inside getLocalEmbedding function");

        try {
            const embeddingManager = LocalEmbeddingModelManager.getInstance();
            return await embeddingManager.generateEmbedding(input);
        } catch (error) {
            elizaLogger.error("Local embedding failed:", error);
            throw error;
        }
    }

    async function retrieveCachedEmbedding(
        runtime: IAgentRuntime,
        input: string
    ) {
        if (!input) {
            elizaLogger.log("No input to retrieve cached embedding for");
            return null;
        }

        const similaritySearchResult =
            await runtime.messageManager.getCachedEmbeddings(input);
        if (similaritySearchResult.length > 0) {
            return similaritySearchResult[0].embedding;
        }
        return null;
    }
}
