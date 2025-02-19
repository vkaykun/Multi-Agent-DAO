import { IAgentRuntime, Memory, UUID, elizaLogger } from "@elizaos/core";
import { BaseMemoryManager } from "./BaseMemoryManager";
import { MemoryQueryOptions } from "../types/memory";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { BaseContent, isUniqueMemoryType, isVersionedMemoryType, UNIQUE_MEMORY_TYPES } from "../types/base";

/**
 * PostgreSQL implementation of the memory manager.
 * Handles all memory operations using a PostgreSQL database.
 */
export class PostgresMemoryManager extends BaseMemoryManager {
    private adapter: PostgresDatabaseAdapter;
    private currentTransaction: any | null = null;
    private writeQueue: Promise<void> = Promise.resolve();
    private writeQueueLock = false;
    protected _isInTransaction = false;

    constructor(
        runtime: IAgentRuntime,
        connectionConfig: {
            connectionString: string;
            maxConnections?: number;
            idleTimeoutMillis?: number;
            ssl?: boolean;
        }
    ) {
        super(runtime, { tableName: "memories" });
        this.adapter = new PostgresDatabaseAdapter({
            ...connectionConfig,
            beginTransaction: async () => {
                await this.adapter.query('BEGIN');
            },
            commitTransaction: async () => {
                await this.adapter.query('COMMIT');
            },
            rollbackTransaction: async () => {
                await this.adapter.query('ROLLBACK');
            }
        });
    }

    get isInTransaction(): boolean {
        return this._isInTransaction;
    }

    async initialize(): Promise<void> {
        await this.adapter.init();
    }

    protected async beginTransactionInternal(): Promise<void> {
        if (this._isInTransaction) {
            throw new Error('Transaction already in progress');
        }
        this.currentTransaction = await this.adapter.query('BEGIN');
        this._isInTransaction = true;
    }

    protected async commitTransactionInternal(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No transaction in progress');
        }
        await this.adapter.query('COMMIT');
        this.currentTransaction = null;
        this._isInTransaction = false;
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        if (!this._isInTransaction) {
            throw new Error('No transaction in progress');
        }
        await this.adapter.query('ROLLBACK');
        this.currentTransaction = null;
        this._isInTransaction = false;
    }

    private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
        // If we're in a transaction, execute immediately
        if (this._isInTransaction) {
            return operation();
        }

        // Otherwise, queue the write
        await this.writeQueue;
        let resolve: () => void;
        const newPromise = new Promise<void>((r) => { resolve = r; });

        try {
            this.writeQueue = newPromise;
            const result = await operation();
            resolve!();
            return result;
        } catch (error) {
            resolve!();
            throw error;
        }
    }

    protected async createMemoryInternal(memory: Memory, unique?: boolean): Promise<void> {
        return this.enqueueWrite(async () => {
            try {
                const content = memory.content as BaseContent;
                const isUniqueType = isUniqueMemoryType(content.type);
                
                // Handle versioning if needed
                if (isVersionedMemoryType(content.type)) {
                    const version = content.metadata?.version || 1;
                    const versionReason = content.metadata?.versionReason || 'Initial version';

                    // First store in versions table
                    await this.adapter.query(
                        `INSERT INTO ${this.tableName}_versions 
                        (id, version, content, room_id, user_id, agent_id, created_at, updated_at, version_reason)
                        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), to_timestamp($8/1000.0), $9)`,
                        [
                            memory.id,
                            version,
                            JSON.stringify(content),
                            memory.roomId,
                            memory.userId,
                            memory.agentId,
                            memory.content.createdAt || Date.now(),
                            memory.content.updatedAt || Date.now(),
                            versionReason
                        ]
                    );
                }

                // For non-versioned types, use appropriate insert strategy
                // If it's a unique type and unique flag is true, use DO NOTHING
                // If it's a unique type and unique flag is false, use DO UPDATE
                // If it's not a unique type, always use DO UPDATE
                const insertType = isUniqueType && memory.unique ? 
                    'ON CONFLICT DO NOTHING' : 
                    'ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at';
                
                await this.adapter.query(
                    `INSERT INTO ${this.tableName} 
                    (id, content, room_id, user_id, agent_id, unique, created_at, updated_at, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), to_timestamp($8/1000.0), $9)
                    ${insertType}`,
                    [
                        memory.id,
                        JSON.stringify(content),
                        memory.roomId,
                        memory.userId,
                        memory.agentId,
                        memory.unique,
                        memory.content.createdAt || Date.now(),
                        memory.content.updatedAt || Date.now(),
                        memory.embedding ? `[${memory.embedding.join(",")}]` : null
                    ]
                );

                elizaLogger.debug(`Created memory ${memory.id}`, {
                    type: content.type,
                    roomId: memory.roomId,
                    unique: memory.unique,
                    versioned: isVersionedMemoryType(content.type)
                });
            } catch (error) {
                elizaLogger.error(`Error creating memory:`, error);
                if (this.currentTransaction) {
                    await this.rollbackTransaction();
                }
                throw error;
            }
        });
    }

    private async checkDuplicate(memory: Memory): Promise<boolean> {
        try {
            // Check for exact content match if memory has an ID
            if (memory.id) {
                const existing = await this.getMemoryById(memory.id);
                if (existing) {
                    return true;
                }
            }

            // Check for content-based duplicates
            const query = `
                SELECT COUNT(*) as count 
                FROM ${this.tableName} 
                WHERE room_id = $1 
                AND content->>'type' = $2
                AND content->>'id' = $3
            `;

            const result = await this.adapter.query(query, [
                memory.roomId,
                memory.content.type,
                memory.content.id
            ]);

            return result.rows[0].count > 0;
        } catch (error) {
            elizaLogger.error(`Error checking for duplicate memory:`, error);
            return false;
        }
    }

    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        const content = memory.content as BaseContent;
        
        if (!isUniqueMemoryType(content.type)) {
            return false;
        }

        const uniqueConstraints = UNIQUE_MEMORY_TYPES[content.type].uniqueBy;
        
        // Build query dynamically based on constraints
        const conditions = uniqueConstraints.map((constraint, index) => {
            const [field, subfield] = constraint.split('.');
            if (subfield) {
                // Handle nested fields (e.g., metadata.proposalId)
                return `content->'${field}'->>'${subfield}' = $${index + 2}`;
            }
            return `content->>'${field}' = $${index + 2}`;
        });

        const query = `
            SELECT COUNT(*) 
            FROM ${this.tableName} 
            WHERE content->>'type' = $1 
            AND ${conditions.join(' AND ')}
        `;

        // Build params array
        const params = [content.type];
        uniqueConstraints.forEach(constraint => {
            const [field, subfield] = constraint.split('.');
            const value = subfield ? 
                (content[field] as any)?.[subfield] : 
                content[field];
            params.push(value);
        });

        try {
            const result = await this.adapter.query(query, params);
            
            if (result.rows[0].count > 0) {
                elizaLogger.debug(`Found existing ${content.type} memory with constraints:`, {
                    type: content.type,
                    constraints: uniqueConstraints,
                    values: params.slice(1)
                });
            }
            
            return result.rows[0].count > 0;
        } catch (error) {
            elizaLogger.error(`Error checking uniqueness for memory type ${content.type}:`, error);
            throw error;
        }
    }

    /**
     * Maps a database row to a Memory object
     */
    private mapRowToMemory(row: any): Memory {
        return {
            id: row.id,
            roomId: row.room_id,
            userId: row.user_id,
            agentId: row.agent_id,
            content: row.content,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined
        };
    }

    protected async getMemoriesInternal(options: MemoryQueryOptions & {
        lastId?: UUID;
        timestamp?: number;
        offset?: number;
        limit?: number;
    }): Promise<Memory[]> {
        const {
            domain,
            unique = false,
            count = this.DEFAULT_PAGE_SIZE,
            lastId,
            timestamp,
            offset,
            limit,
            types
        } = options;

        let query = `
            SELECT m.* 
            FROM ${this._tableName} m
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (domain) {
            query += ` AND m.room_id = $${paramIndex}`;
            params.push(domain);
            paramIndex++;
        }

        if (timestamp) {
            query += ` AND m.created_at > to_timestamp($${paramIndex})`;
            params.push(timestamp / 1000.0); // Convert to seconds for PostgreSQL
            paramIndex++;
        }

        if (types && types.length > 0) {
            query += ` AND m.content->>'type' = ANY($${paramIndex}::text[])`;
            params.push(types);
            paramIndex++;
        }

        if (lastId) {
            query += ` AND m.id > $${paramIndex}`;
            params.push(lastId);
            paramIndex++;
        }

        if (unique) {
            query += ` AND m.content->>'type' = ANY($${paramIndex}::text[])`;
            params.push(UNIQUE_MEMORY_TYPES);
            paramIndex++;
        }

        query += ` ORDER BY m.created_at DESC`;

        if (limit) {
            query += ` LIMIT $${paramIndex}`;
            params.push(limit);
            paramIndex++;
        }

        if (offset) {
            query += ` OFFSET $${paramIndex}`;
            params.push(offset);
        }

        const result = await this.adapter.query(query, params);
        return result.rows.map((row) => this.mapRowToMemory(row));
    }

    async getMemories(options: MemoryQueryOptions): Promise<Memory[]> {
        const { domain, ...rest } = options;
        return this.adapter.getMemories({
            ...rest,
            roomId: domain as UUID,
            tableName: this.tableName
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // The core adapter handles embeddings automatically
        return memory;
    }

    async getCachedEmbeddings(content: string): Promise<{ embedding: number[]; levenshtein_score: number; }[]> {
        const memories = await this.adapter.searchMemoriesByEmbedding([], {
            tableName: this.tableName,
            match_threshold: 0.95
        });
        return memories.map(m => ({
            embedding: m.embedding || [],
            levenshtein_score: 1.0
        }));
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[]; limit?: number }): Promise<Memory[]> {
        const allMemories: Memory[] = [];
        for (const roomId of params.roomIds) {
            const memories = await this.adapter.getMemories({
                roomId,
                count: params.limit,
                tableName: this.tableName
            });
            allMemories.push(...memories);
        }
        return allMemories;
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: { 
            match_threshold?: number; 
            count?: number; 
            roomId: UUID; 
            unique?: boolean;
            lastId?: UUID;
            offset?: number;
        }
    ): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, {
            tableName: this.tableName,
            match_threshold: opts.match_threshold,
            count: opts.count,
            roomId: opts.roomId,
            unique: opts.unique
        });
    }

    async removeMemory(id: UUID): Promise<void> {
        return this.enqueueWrite(async () => {
            try {
                if (this.currentTransaction) {
                    await this.adapter.query(
                        `DELETE FROM ${this.tableName} WHERE id = $1`,
                        [id]
                    );
                } else {
                    await this.adapter.removeMemory(id, this.tableName);
                }
            } catch (error) {
                elizaLogger.error(`Error removing memory:`, error);
                if (this.currentTransaction) {
                    await this.rollbackTransaction();
                }
                throw error;
            }
        });
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        return this.enqueueWrite(async () => {
            await this.adapter.removeAllMemories(roomId, this.tableName);
        });
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return this.adapter.countMemories(roomId, unique, this.tableName);
    }

    async shutdown(): Promise<void> {
        // Wait for any pending writes to complete
        await this.writeQueue;
        await this.adapter.close();
    }

    protected async searchMemoriesByEmbeddingInternal(
        embedding: number[],
        opts: { 
            match_threshold?: number; 
            count?: number; 
            roomId: UUID; 
            unique?: boolean;
            query?: string;
        }
    ): Promise<Memory[]> {
        return this.adapter.searchMemoriesByEmbedding(embedding, {
            tableName: this.tableName,
            match_threshold: opts.match_threshold,
            count: opts.count,
            roomId: opts.roomId,
            unique: opts.unique
        });
    }

    protected async searchMemoriesByText(
        roomId: UUID,
        predicate: (memory: Memory) => boolean,
        limit?: number
    ): Promise<Memory[]> {
        const memories = await this.adapter.getMemories({
            roomId,
            count: limit,
            tableName: this.tableName
        });
        return memories.filter(predicate);
    }

    async getMemoryVersions(id: UUID): Promise<Memory[]> {
        const result = await this.adapter.query(
            `SELECT * FROM ${this.tableName}_versions 
             WHERE id = $1 
             ORDER BY version DESC`,
            [id]
        );

        return result.rows.map(row => this.mapRowToMemory(row));
    }

    async getMemoryVersion(id: UUID, version: number): Promise<Memory | null> {
        const result = await this.adapter.query(
            `SELECT * FROM ${this.tableName}_versions 
             WHERE id = $1 AND version = $2`,
            [id, version]
        );

        return result.rows.length > 0 ? this.mapRowToMemory(result.rows[0]) : null;
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        await this.adapter.query(
            `UPDATE ${this.tableName} 
             SET content = $1, updated_at = $2
             WHERE id = $3`,
            [JSON.stringify(memory.content), Date.now(), memory.id]
        );
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.adapter.query(
            `DELETE FROM ${this.tableName} WHERE id = $1`,
            [id]
        );
    }
} 