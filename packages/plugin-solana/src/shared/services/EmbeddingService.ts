// packages/plugin-solana/src/shared/services/EmbeddingService.ts

import { IAgentRuntime, elizaLogger, Service, ServiceType } from "@elizaos/core";

export interface EmbeddingConfig {
    enabled: boolean;
    dimension: number;
    modelName?: string;
    batchSize?: number;
    cacheResults?: boolean;
}

export class EmbeddingService {
    private static instance: EmbeddingService;
    private textGenService?: Service & { getEmbeddingResponse(text: string): Promise<number[]> };
    private config: EmbeddingConfig;

    private constructor(
        private runtime: IAgentRuntime,
        config: Partial<EmbeddingConfig>
    ) {
        // Check both old and new embedding control flags
        const isDisabled = process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true";
        
        this.config = {
            enabled: !isDisabled && process.env.USE_EMBEDDINGS === "true",
            dimension: process.env.VECTOR_DIMENSION ? parseInt(process.env.VECTOR_DIMENSION) : 1536, // Use 1536 dimensions to match OpenAI text-embedding-ada-002 model
            modelName: process.env.EMBEDDING_MODEL || "text-embedding-ada-002",
            batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || "10"),
            cacheResults: process.env.CACHE_EMBEDDINGS === "true",
            ...config
        };

        if (this.config.enabled) {
            this.initializeService();
            elizaLogger.info(`Embeddings enabled with dimension: ${this.config.dimension}, model: ${this.config.modelName}`);
        } else {
            elizaLogger.info("Embeddings disabled via environment settings");
        }
    }

    public static getInstance(runtime: IAgentRuntime, config?: Partial<EmbeddingConfig>): EmbeddingService {
        if (!this.instance) {
            this.instance = new EmbeddingService(runtime, config || {});
        }
        return this.instance;
    }

    private initializeService(): void {
        try {
            this.textGenService = this.runtime.getService(ServiceType.TEXT_GENERATION) as Service & {
                getEmbeddingResponse(text: string): Promise<number[]>;
            };

            if (!this.textGenService) {
                elizaLogger.warn("Text generation service not available. Embeddings will be disabled.");
                this.config.enabled = false;
            }
        } catch (error) {
            elizaLogger.error("Failed to initialize embedding service:", error);
            this.config.enabled = false;
        }
    }

    public isEnabled(): boolean {
        return this.config.enabled && !!this.textGenService;
    }

    public getDimension(): number {
        return this.config.dimension;
    }

    public async getEmbedding(text: string): Promise<number[] | null> {
        // If service is disabled or no text provided
        if (!this.isEnabled() || !text) {
            // Return a zero vector instead of null for better compatibility
            if (process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true") {
                elizaLogger.debug("Embeddings disabled, returning zero vector");
                return new Array(this.config.dimension).fill(0);
            }
            return null;
        }

        try {
            const embedding = await this.textGenService!.getEmbeddingResponse(text);
            
            // Validate embedding dimension
            if (embedding.length !== this.config.dimension) {
                elizaLogger.warn(`Embedding dimension mismatch: expected ${this.config.dimension}, got ${embedding.length}`);
                
                // If adaptation is enabled, try to adapt the vector
                if (process.env.VECTOR_DIMENSION_ADAPT === "true") {
                    return this.adaptVectorDimension(embedding, this.config.dimension);
                }
            }
            
            return embedding;
        } catch (error) {
            elizaLogger.error("Error generating embedding:", error);
            // Return a zero vector on error for better fault tolerance
            return new Array(this.config.dimension).fill(0);
        }
    }

    /**
     * Adapts a vector to the target dimension by repeating or averaging values
     */
    private adaptVectorDimension(vector: number[], targetDimension: number): number[] {
        if (vector.length === targetDimension) return vector;
        
        elizaLogger.info(`Adapting vector from ${vector.length}D to ${targetDimension}D`);
        
        // Convert from 384 to 1536 (upscale)
        if (vector.length === 384 && targetDimension === 1536) {
            // Repeat each value 4 times to fill the larger dimension
            const newVector = [];
            for (let i = 0; i < vector.length; i++) {
                for (let j = 0; j < 4; j++) {
                    newVector.push(vector[i]);
                }
            }
            return newVector;
        }
        
        // Convert from 1536 to 384 (downscale)
        if (vector.length === 1536 && targetDimension === 384) {
            // Take average of each group of 4 values
            const newVector = [];
            for (let i = 0; i < vector.length; i += 4) {
                const avg = (vector[i] + vector[i+1] + vector[i+2] + vector[i+3]) / 4;
                newVector.push(avg);
            }
            return newVector;
        }
        
        // Fallback for other dimensions: simple scaling
        const newVector = new Array(targetDimension).fill(0);
        for (let i = 0; i < targetDimension; i++) {
            const sourceIndex = Math.floor(i * (vector.length / targetDimension));
            newVector[i] = vector[sourceIndex];
        }
        
        return newVector;
    }

    public async getEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
        // If embeddings are globally disabled, return zero vectors
        if (process.env.DISABLE_EMBEDDINGS?.toLowerCase() === "true") {
            elizaLogger.debug("Embeddings disabled, returning zero vectors for batch");
            return texts.map(() => new Array(this.config.dimension).fill(0));
        }
        
        // Otherwise use normal disabled logic
        if (!this.isEnabled() || texts.length === 0) {
            return texts.map(() => null);
        }

        const batchSize = this.config.batchSize || 10;
        const results: (number[] | null)[] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(text => this.getEmbedding(text))
            );
            results.push(...batchResults);
        }

        return results;
    }

    public calculateSimilarity(embedding1: number[], embedding2: number[]): number {
        if (embedding1.length !== embedding2.length) {
            throw new Error("Embeddings must have the same dimension");
        }

        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < embedding1.length; i++) {
            dotProduct += embedding1[i] * embedding2[i];
            norm1 += embedding1[i] * embedding1[i];
            norm2 += embedding2[i] * embedding2[i];
        }

        return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    }
} 