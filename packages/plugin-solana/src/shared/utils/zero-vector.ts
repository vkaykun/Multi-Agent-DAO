import { STANDARD_VECTOR_DIMENSION } from './embedding-validator';

/**
 * Creates a zero vector with the standard dimension for embeddings.
 * This ensures consistent dimensions across the system.
 * 
 * @returns A vector of zeros with the standard dimension
 */
export function getZeroVector(): number[] {
  return new Array(STANDARD_VECTOR_DIMENSION).fill(0);
}

/**
 * Creates a random vector with the standard dimension for embeddings.
 * Useful for testing or as a placeholder when real embeddings are not available.
 * 
 * @returns A vector of random values with the standard dimension
 */
export function getRandomVector(): number[] {
  return Array.from({ length: STANDARD_VECTOR_DIMENSION }, () => Math.random() * 2 - 1);
}

/**
 * Normalizes a vector to unit length.
 * 
 * @param vector The vector to normalize
 * @returns The normalized vector
 */
export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  
  if (magnitude === 0) {
    return vector; // Avoid division by zero
  }
  
  return vector.map(val => val / magnitude);
} 