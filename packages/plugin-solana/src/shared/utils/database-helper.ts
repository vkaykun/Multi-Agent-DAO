/**
 * Database helper utilities for disabled embeddings
 */

import { IAgentRuntime, elizaLogger } from "@elizaos/core";

/**
 * Checks if embeddings are disabled in the environment
 */
export function areEmbeddingsDisabled(): boolean {
    return process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";
}

/**
 * Helper function to safely perform memory operations when embeddings are disabled
 * Use this to wrap any database adapter methods that involve vector operations
 */
export async function safelyPerformVectorOperation<T>(
    runtime: IAgentRuntime,
    operation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    operationName: string
): Promise<T> {
    if (areEmbeddingsDisabled()) {
        elizaLogger.debug(`Embeddings disabled, skipping vector operation: ${operationName}`);
        return await fallbackOperation();
    }
    
    try {
        return await operation();
    } catch (error) {
        if (
            error instanceof Error &&
            (error.message.includes("embedding dimension") || 
             error.message.includes("vector dimensions"))
        ) {
            elizaLogger.warn(`Vector dimension error in ${operationName}, using fallback`, {
                error: error.message
            });
            return await fallbackOperation();
        }
        throw error;
    }
}

/**
 * Gets a safe zero vector of the correct dimension (1536)
 */
export function getSafeZeroVector(): number[] {
    return Array(1536).fill(0);
} 