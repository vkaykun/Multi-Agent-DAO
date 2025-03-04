import { debug } from "debug";
import type { Memory } from "@elizaos/core";
import { enforceEmbeddingDimension } from "./embedding-validator";

const logger = debug("plugin-solana:embedding-helpers");

/**
 * Enhances a memory object with properly dimensioned embedding.
 * This should be used before storing a memory to ensure consistent dimensions.
 * 
 * @param memory The memory object to enhance
 * @returns The memory with validated embedding
 */
export async function enhanceMemoryWithConsistentEmbedding(memory: Memory): Promise<Memory> {
  if (!memory.embedding) return memory;
  
  // Enforce the proper dimension on the embedding
  const consistentEmbedding = enforceEmbeddingDimension(memory.embedding);
  
  // Return the memory with the adjusted embedding
  return {
    ...memory,
    embedding: consistentEmbedding
  };
}

/**
 * Creates a wrapper for the addEmbeddingToMemory function that ensures consistent dimensions.
 * 
 * @param originalFn The original addEmbeddingToMemory function
 * @returns A wrapped function that ensures consistent embedding dimensions
 */
export function createConsistentEmbeddingWrapper(
  originalFn: (memory: Memory) => Promise<Memory>
): (memory: Memory) => Promise<Memory> {
  return async function wrappedAddEmbeddingToMemory(memory: Memory): Promise<Memory> {
    try {
      // Call the original function
      const memoryWithEmbedding = await originalFn(memory);
      
      // Ensure the embedding has the correct dimension
      return await enhanceMemoryWithConsistentEmbedding(memoryWithEmbedding);
    } catch (error) {
      // Log the error but don't break the operation
      logger(`Error during embedding enhancement: ${error instanceof Error ? error.message : String(error)}`);
      
      // Return the original memory as a fallback
      return memory;
    }
  };
}

/**
 * Monkey-patches the provided memory manager to ensure all embeddings have consistent dimensions.
 * 
 * @param memoryManager The memory manager to patch
 */
export function patchMemoryManagerForConsistentEmbeddings(memoryManager: any): void {
  if (!memoryManager || typeof memoryManager.addEmbeddingToMemory !== 'function') {
    logger("Cannot patch memory manager: addEmbeddingToMemory method not found");
    return;
  }
  
  // Store the original method
  const originalMethod = memoryManager.addEmbeddingToMemory;
  
  // Replace with our wrapped version
  memoryManager.addEmbeddingToMemory = createConsistentEmbeddingWrapper(originalMethod.bind(memoryManager));
  
  logger("✅ Memory manager patched for consistent 1536D embeddings");
} 