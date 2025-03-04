import { debug } from "debug";

const logger = debug("plugin-solana:embedding-validator");

/**
 * The standard vector dimension for embeddings throughout the system
 */
export const STANDARD_VECTOR_DIMENSION = 1536;

/**
 * The standard OpenAI embedding model used throughout the system
 */
export const STANDARD_EMBEDDING_MODEL = "text-embedding-ada-002";

/**
 * Validates that the environment configuration for embeddings matches our standards.
 * Should be called during system initialization.
 */
export function validateEmbeddingConfiguration(): void {
  const vectorDimension = process.env.VECTOR_DIMENSION;
  const embeddingModel = process.env.EMBEDDING_OPENAI_MODEL;
  
  logger("Validating embedding configuration...");

  if (!vectorDimension) {
    logger("⚠️ VECTOR_DIMENSION not found in environment variables, using default 1536");
  } else if (vectorDimension !== String(STANDARD_VECTOR_DIMENSION)) {
    logger(`⚠️ VECTOR_DIMENSION (${vectorDimension}) does not match standard (${STANDARD_VECTOR_DIMENSION})`);
  } else {
    logger(`✅ VECTOR_DIMENSION configured correctly: ${vectorDimension}`);
  }

  if (!embeddingModel) {
    logger("⚠️ EMBEDDING_OPENAI_MODEL not found in environment variables, using default text-embedding-ada-002");
  } else if (embeddingModel !== STANDARD_EMBEDDING_MODEL) {
    logger(`⚠️ EMBEDDING_OPENAI_MODEL (${embeddingModel}) does not match standard (${STANDARD_EMBEDDING_MODEL})`);
  } else {
    logger(`✅ EMBEDDING_OPENAI_MODEL configured correctly: ${embeddingModel}`);
  }
}

/**
 * Enforces the standard embedding dimension on a vector.
 * If the vector already has the correct dimension, it is returned as is.
 * Otherwise, it is padded or truncated to match the standard dimension.
 * 
 * @param embedding The embedding vector to adjust
 * @returns A vector with the standard dimension
 */
export function enforceEmbeddingDimension(embedding: number[]): number[] {
  const embeddingLength = embedding.length;
  
  // If already the correct dimension, return as is
  if (embeddingLength === STANDARD_VECTOR_DIMENSION) {
    return embedding;
  }
  
  logger(`Adjusting embedding dimension from ${embeddingLength} to ${STANDARD_VECTOR_DIMENSION}`);
  
  if (embeddingLength < STANDARD_VECTOR_DIMENSION) {
    // Pad with zeros to reach the standard dimension
    const padding = new Array(STANDARD_VECTOR_DIMENSION - embeddingLength).fill(0);
    return [...embedding, ...padding];
  } else {
    // Truncate to the standard dimension
    return embedding.slice(0, STANDARD_VECTOR_DIMENSION);
  }
}

/**
 * Validates if an embedding has the standard dimension.
 * 
 * @param embedding The embedding to validate
 * @returns True if the embedding has the standard dimension
 */
export function hasStandardDimension(embedding: number[]): boolean {
  return embedding.length === STANDARD_VECTOR_DIMENSION;
}

/**
 * Checks if the OpenAI model being used matches our standard model.
 * 
 * @param model The OpenAI model name to check
 * @returns True if the model matches our standard
 */
export function isStandardEmbeddingModel(model: string): boolean {
  return model === STANDARD_EMBEDDING_MODEL;
} 