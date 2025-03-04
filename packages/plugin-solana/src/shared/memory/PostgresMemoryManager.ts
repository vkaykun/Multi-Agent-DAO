// packages/plugin-solana/src/shared/memory/PostgresMemoryManager.ts

import { IAgentRuntime, Memory, UUID, elizaLogger } from "@elizaos/core";
import { BaseMemoryManager, VersionHistory } from "./BaseMemoryManager.ts";
import { MemoryQueryOptions } from "../types/memory.ts";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { BaseContent, isUniqueMemoryType, isVersionedMemoryType, UNIQUE_MEMORY_TYPES } from "../types/base.ts";
import { CONVERSATION_ROOM_ID } from "../utils/messageUtils.js";
import { v4 } from "uuid";

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
    protected transactionLevel = 0;
    protected savepointCounter = 0;

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

    get currentTransactionLevel(): number {
        return this.transactionLevel;
    }

    async initialize(): Promise<void> {
        await this.adapter.init();
        
        // Create memories table with all required columns and constraints
        await this.adapter.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id UUID PRIMARY KEY,
                content JSONB NOT NULL,
                room_id UUID NOT NULL,
                user_id UUID NOT NULL,
                agent_id UUID NOT NULL,
                unique BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                embedding FLOAT[]
            );

            -- Index for room-based queries (heavily used in getMemories)
            CREATE INDEX IF NOT EXISTS idx_memories_room_id 
            ON ${this.tableName}(room_id);

            -- Index for content type lookups (used in memory subscriptions)
            CREATE INDEX IF NOT EXISTS idx_memories_content_type 
            ON ${this.tableName}((content->>'type'));

            -- Index for timestamp-based queries
            CREATE INDEX IF NOT EXISTS idx_memories_created_at 
            ON ${this.tableName}(created_at DESC);

            -- Partial unique index for distributed locks
            CREATE UNIQUE INDEX IF NOT EXISTS idx_active_distributed_locks 
            ON ${this.tableName} ((content->>'key'))
            WHERE content->>'type' = 'distributed_lock' 
            AND content->>'lockState' = 'active';

            -- Composite index for room + type queries
            CREATE INDEX IF NOT EXISTS idx_memories_room_type 
            ON ${this.tableName}(room_id, (content->>'type'));

            -- Index for user-specific queries
            CREATE INDEX IF NOT EXISTS idx_memories_user_id 
            ON ${this.tableName}(user_id);

            -- Index for agent-specific queries
            CREATE INDEX IF NOT EXISTS idx_memories_agent_id 
            ON ${this.tableName}(agent_id);
        `);

        // Create versions table for versioned memory types
        await this.adapter.query(`
            CREATE TABLE IF NOT EXISTS ${this.tableName}_versions (
                id UUID NOT NULL,
                version INTEGER NOT NULL,
                content JSONB NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                version_reason TEXT,
                PRIMARY KEY (id, version),
                FOREIGN KEY (id) REFERENCES ${this.tableName}(id) ON DELETE CASCADE
            );

            -- Index for version history queries
            CREATE INDEX IF NOT EXISTS idx_memory_versions_id_version 
            ON ${this.tableName}_versions(id, version DESC);
        `);

        // Add triggers for automatic timestamp updates
        await this.adapter.query(`
            CREATE OR REPLACE FUNCTION update_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';

            DROP TRIGGER IF EXISTS update_memories_updated_at 
            ON ${this.tableName};

            CREATE TRIGGER update_memories_updated_at
            BEFORE UPDATE ON ${this.tableName}
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
        `);

        // Add row-level security if enabled
        if (process.env.ENABLE_RLS === 'true') {
            await this.adapter.query(`
                ALTER TABLE ${this.tableName} ENABLE ROW LEVEL SECURITY;
                
                -- Policy: Agents can only access memories in their rooms
                CREATE POLICY agent_room_access ON ${this.tableName}
                FOR ALL
                TO authenticated
                USING (
                    room_id = current_setting('app.current_room_id')::uuid
                    OR agent_id = current_setting('app.current_agent_id')::uuid
                );
            `);
        }

        elizaLogger.info(`Initialized PostgresMemoryManager tables and indexes`);
    }

    protected async beginTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            // Start a new top-level transaction
            this.currentTransaction = await this.adapter.query('BEGIN');
            this._isInTransaction = true;
        } else {
            // Create a savepoint for nested transaction
            const savepointName = `sp_${++this.savepointCounter}`;
            await this.adapter.query(`SAVEPOINT ${savepointName}`);
        }
        this.transactionLevel++;
    }

    protected async commitTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            throw new Error('No transaction in progress');
        }

        this.transactionLevel--;

        if (this.transactionLevel === 0) {
            // Commit the top-level transaction
            await this.adapter.query('COMMIT');
            this.currentTransaction = null;
            this._isInTransaction = false;
            this.savepointCounter = 0;
        } else {
            // Release the savepoint
            const savepointName = `sp_${this.savepointCounter--}`;
            await this.adapter.query(`RELEASE SAVEPOINT ${savepointName}`);
        }
    }

    protected async rollbackTransactionInternal(): Promise<void> {
        if (this.transactionLevel === 0) {
            throw new Error('No transaction in progress');
        }

        if (this.transactionLevel === 1) {
            // Rollback the entire transaction
            await this.adapter.query('ROLLBACK');
            this.currentTransaction = null;
            this._isInTransaction = false;
            this.savepointCounter = 0;
        } else {
            // Rollback to the last savepoint
            const savepointName = `sp_${this.savepointCounter--}`;
            await this.adapter.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        }
        this.transactionLevel--;
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

    protected async createMemoryInternal(memory: Memory): Promise<void> {
        try {
            // Use memory.type if it exists, otherwise fall back to content.type
            const typeField = memory.type || memory.content?.type;
            
            elizaLogger.debug(`Creating memory with type: ${typeField}`, {
                explicitType: memory.type,
                contentType: memory.content?.type,
                finalType: typeField
            });

            // Ensure we have a valid type
            if (!typeField) {
                throw new Error('Memory must have either memory.type or memory.content.type set');
            }

            // Insert the memory with the type field
            const query = `
                INSERT INTO ${this.tableName} (
                    id, 
                    type,
                    content, 
                    room_id, 
                    user_id, 
                    agent_id, 
                    unique, 
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;

            await this.adapter.query(query, [
                memory.id || v4(),
                typeField,
                memory.content,
                memory.roomId,
                memory.userId,
                memory.agentId,
                memory.unique ?? true,
                memory.createdAt ? new Date(memory.createdAt) : new Date()
            ]);

            if (memory.content?.type === "wallet_registration" || 
                memory.content?.type === "pending_wallet_registration") {
                elizaLogger.info("WALLET REGISTRATION MEMORY CREATED", {
                    operation: "createMemory",
                    memoryType: typeField,
                    memoryId: memory.id,
                    roomId: memory.roomId,
                    userId: memory.userId,
                    walletAddress: memory.content.walletAddress,
                    status: memory.content.status,
                    isTreasuryOperation: true
                });
            }

        } catch (error) {
            elizaLogger.error('Error creating memory:', error);
            if (this.currentTransaction) {
                await this.rollbackTransaction();
            }
            throw error;
        }
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

    /**
     * Get memories with enhanced filtering capabilities
     * This method provides support for complex filters like MongoDB-style queries
     */
    async getMemoriesWithFilters(options: {
        roomId: UUID;
        filter?: Record<string, any>;
        count?: number;
        sortBy?: string;
        sortDirection?: 'asc' | 'desc';
        unique?: boolean;
        _treasuryOperation?: boolean;
    }): Promise<Memory[]> {
        elizaLogger.debug("PostgresMemoryManager.getMemoriesWithFilters called", {
            filter: JSON.stringify(options.filter || {}),
            roomId: options.roomId
        });
        
        // Check if it's a wallet registration query - look for wallet_registration in filter
        const isWalletRegistrationQuery = options.filter && (
            // Check for content.type being wallet_registration
            (options.filter["content.type"] && 
             (options.filter["content.type"] === "wallet_registration" ||
              options.filter["content.type"] === "pending_wallet_registration")) ||
            // Or check for _treasuryOperation flag
            options._treasuryOperation === true || 
            options.filter?._treasuryOperation === true
        );
        
        // For treasury operations, ensure we never reject the special conversation ID
        if (isWalletRegistrationQuery) {
            // If it's a wallet registration and roomId is the special conversation ID or missing, 
            // use the special conversation room ID to ensure wallet lookups work properly
            if (!options.roomId || options.roomId === CONVERSATION_ROOM_ID) {
                elizaLogger.info("Using conversation room ID for wallet registration query in PostgresMemoryManager", {
                    filter: JSON.stringify(options.filter),
                    roomId: CONVERSATION_ROOM_ID
                });
                options.roomId = CONVERSATION_ROOM_ID;
            }
        }
        // Handle non-treasury operations with regular roomId validation
        else if (!options.roomId) {
            if (process.env.DISABLE_EMBEDDINGS === 'true') {
                elizaLogger.warn("Missing roomId in PostgresMemoryManager.getMemoriesWithFilters with embeddings disabled, returning empty array");
                return [];
            }
            // For non-treasury operations with missing roomId and embeddings enabled, we'll let the try/catch handle it
        }
        
        try {
            // Get base memories from the database
            const memories = await this.getMemoriesInternal({
                domain: options.roomId,
                count: options.count || 50, // Higher default to ensure all matches
                unique: options.unique
            });
            
            // If no filter, just return memories
            if (!options.filter) {
                return memories;
            }
            
            // Apply filtering
            const filteredMemories = this.filterMemoriesComplex(memories, options.filter);
            
            // Apply sorting if needed
            let results = filteredMemories;
            if (options.sortBy) {
                results = this.sortMemories(results, options.sortBy, options.sortDirection || 'desc');
            }
            
            // Apply count limit if specified
            if (options.count && results.length > options.count) {
                results = results.slice(0, options.count);
            }
            
            elizaLogger.debug(`PostgresMemoryManager.getMemoriesWithFilters returning ${results.length} results`, {
                firstResultType: results.length > 0 ? results[0]?.content?.type : 'none'
            });
            
            return results;
        } catch (error) {
            elizaLogger.error("Error in getMemoriesWithFilters", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            return [];
        }
    }
    
    /**
     * Enhanced filtering that supports MongoDB-style operators
     */
    private filterMemoriesComplex(memories: Memory[], filter: Record<string, any>): Memory[] {
        return memories.filter(memory => {
            return Object.entries(filter).every(([key, value]) => {
                // Get the actual value from the memory using dot notation
                const actualValue = this.getNestedProperty(memory, key);
                
                // Handle different filter types
                if (value === null) {
                    return actualValue === null;
                }
                
                // Handle MongoDB-style operators
                if (typeof value === 'object' && value !== null) {
                    // $eq operator
                    if (value.$eq !== undefined) {
                        return actualValue === value.$eq;
                    }
                    
                    // $in operator
                    if (value.$in !== undefined && Array.isArray(value.$in)) {
                        return value.$in.includes(actualValue);
                    }
                    
                    // Handle nested object comparison
                    if (!Array.isArray(value) && !('$eq' in value) && !('$in' in value)) {
                        return JSON.stringify(actualValue) === JSON.stringify(value);
                    }
                }
                
                // Simple equality for primitive values
                return actualValue === value;
            });
        });
    }
    
    /**
     * Helper to get nested property using dot notation
     */
    private getNestedProperty(obj: any, path: string): any {
        return path.split('.').reduce((prev, curr) => 
            prev && prev[curr] !== undefined ? prev[curr] : undefined, obj);
    }
    
    /**
     * Sort memories by a property (using dot notation if needed)
     */
    private sortMemories(memories: Memory[], sortBy: string, sortDirection: string = 'desc'): Memory[] {
        return [...memories].sort((a, b) => {
            const aValue = this.getNestedProperty(a, sortBy);
            const bValue = this.getNestedProperty(b, sortBy);
            
            if (aValue === undefined && bValue === undefined) return 0;
            if (aValue === undefined) return sortDirection === 'desc' ? 1 : -1;
            if (bValue === undefined) return sortDirection === 'desc' ? -1 : 1;
            
            // Compare dates if they look like timestamps
            if (typeof aValue === 'number' && typeof bValue === 'number') {
                return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
            }
            
            // String comparison
            const aStr = String(aValue);
            const bStr = String(bValue);
            return sortDirection === 'desc' ? 
                bStr.localeCompare(aStr) : 
                aStr.localeCompare(bStr);
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

    protected async storeVersionHistory(version: VersionHistory): Promise<void> {
        const query = `
            INSERT INTO ${this.tableName}_versions (
                id, version, content, created_at
            ) VALUES ($1, $2, $3, $4)
        `;
        
        await this.adapter.query(query, [
            version.id,
            version.version,
            JSON.stringify(version.content),
            version.createdAt
        ]);
    }

    public async getMemoryVersions(id: UUID): Promise<Memory[]> {
        const query = `
            SELECT id, version, content, created_at
            FROM ${this.tableName}_versions
            WHERE id = $1
            ORDER BY version DESC
        `;
        
        const result = await this.adapter.query(query, [id]);
        return result.rows.map(row => ({
            id: row.id,
            content: JSON.parse(row.content),
            roomId: JSON.parse(row.content).roomId,
            userId: JSON.parse(row.content).userId,
            agentId: JSON.parse(row.content).agentId
        }));
    }

    public async getMemoryVersion(id: UUID, version: number): Promise<Memory | null> {
        const query = `
            SELECT id, version, content, created_at
            FROM ${this.tableName}_versions
            WHERE id = $1 AND version = $2
        `;
        
        const result = await this.adapter.query(query, [id, version]);
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            id: row.id,
            content: JSON.parse(row.content),
            roomId: JSON.parse(row.content).roomId,
            userId: JSON.parse(row.content).userId,
            agentId: JSON.parse(row.content).agentId
        };
    }

    protected async getMemoryInternal(id: UUID): Promise<Memory | null> {
        return this.adapter.getMemoryById(id);
    }

    protected async updateMemoryInternal(memory: Memory): Promise<void> {
        const query = `
            UPDATE ${this.tableName}
            SET content = $2, updated_at = $3
            WHERE id = $1
        `;
        
        await this.adapter.query(query, [
            memory.id,
            JSON.stringify(memory.content),
            Date.now()
        ]);
    }

    protected async removeMemoryInternal(id: UUID): Promise<void> {
        await this.adapter.query(
            `DELETE FROM ${this.tableName} WHERE id = $1`,
            [id]
        );
    }

    /**
     * Retrieve a single memory with row-level locking using FOR UPDATE.
     * This ensures exclusive access to the row until the transaction is committed.
     */
    public async getMemoryWithLock(id: UUID): Promise<Memory | null> {
        if (!this.isInTransaction) {
            throw new Error("getMemoryWithLock must be called within a transaction");
        }

        try {
            const result = await this.adapter.query(`
                SELECT m.*, e.embedding 
                FROM ${this.tableName} m
                LEFT JOIN embeddings e ON m.id = e.memory_id
                WHERE m.id = $1
                FOR UPDATE
            `, [id]);

            if (result.rows.length === 0) {
                return null;
            }

            return this.mapRowToMemory(result.rows[0]);
        } catch (error) {
            elizaLogger.error(`Error in getMemoryWithLock for id ${id}:`, error);
            throw error;
        }
    }

    /**
     * Retrieve multiple memories with row-level locking using FOR UPDATE.
     * Supports filtering and ordering by creation time.
     */
    public async getMemoriesWithLock(opts: {
        roomId: UUID;
        count: number;
        filter?: Record<string, any>;
    }): Promise<Memory[]> {
        try {
            // Get transaction client
            await this.beginTransaction();

            let query = `
                SELECT * FROM ${this.tableName} WHERE room_id = $1
            `;

            const params: any[] = [opts.roomId];
            let paramIndex = 2;

            if (opts.filter) {
                // Log the filter for debugging
                elizaLogger.debug("MEMORY FILTER IN GETMEMORIESWITHLOCK", {
                    filter: JSON.stringify(opts.filter),
                    roomId: opts.roomId,
                    operation: "getMemoriesWithLock"
                });

                // Process content.type filter - ensure exact matches
                if (opts.filter["content.type"]) {
                    const typeFilter = opts.filter["content.type"];
                    
                    // Check if this is a strict type match (from normalizeWalletFilter)
                    const isExactTypeMatch = typeFilter.$_exact_type_match === true;
                    
                    if (typeof typeFilter === 'string') {
                        // Simple string equality
                        query += ` AND content->>'type' = $${paramIndex}`;
                        params.push(typeFilter);
                        paramIndex++;
                    } else if (typeFilter.$eq) {
                        // Explicit equality operator
                        query += ` AND content->>'type' = $${paramIndex}`;
                        params.push(typeFilter.$eq);
                        paramIndex++;
                        
                        // Add diagnostic logging for exact type matches
                        if (isExactTypeMatch) {
                            elizaLogger.info("EXACT TYPE MATCH FILTER", {
                                requestedType: typeFilter.$eq,
                                operation: "getMemoriesWithLock"
                            });
                        }
                    } else if (typeFilter.$in) {
                        // IN operator for multiple potential types
                        query += ` AND content->>'type' = ANY($${paramIndex}::text[])`;
                        params.push(typeFilter.$in);
                        paramIndex++;
                    }
                    
                    // Handle explicit exclusion of user_message type if specified
                    if (opts.filter["_not_type"] && opts.filter["_not_type"].$ne) {
                        query += ` AND content->>'type' != $${paramIndex}`;
                        params.push(opts.filter["_not_type"].$ne);
                        paramIndex++;
                        
                        elizaLogger.info("EXCLUDING TYPE", {
                            excludedType: opts.filter["_not_type"].$ne,
                            operation: "getMemoriesWithLock"
                        });
                    }
                }
                
                // Handle direct content type check - this ensures proper JSON path traversal
                if (opts.filter["_direct_content_type_check"]) {
                    const directCheck = opts.filter["_direct_content_type_check"];
                    // Use the JSONB containment operator @> to ensure exact field matching
                    query += ` AND content @> $${paramIndex}::jsonb`;
                    // Create a properly nested JSON object for the containment check
                    const jsonFilter = JSON.stringify({ 
                        type: directCheck.value 
                    });
                    params.push(jsonFilter);
                    paramIndex++;
                    
                    elizaLogger.info("DIRECT CONTENT TYPE CHECK", {
                        field: directCheck.field,
                        value: directCheck.value,
                        jsonFilter,
                        operation: "getMemoriesWithLock"
                    });
                }

                // Process other content.* filters
                Object.entries(opts.filter).forEach(([key, value]) => {
                    // Skip already processed filters
                    if (key === 'content.type' || key === '_not_type') return;
                    
                    if (key.startsWith('content.')) {
                        const path = key.split('.');
                        
                        if (path.length === 2) {
                            const field = path[1];
                            
                            if (typeof value === 'object' && value !== null) {
                                if (value.$eq) {
                                    // Exact equality
                                    query += ` AND content->>'${field}' = $${paramIndex}`;
                                    params.push(value.$eq);
                                    paramIndex++;
                                } else if (value.$in) {
                                    // IN operator
                                    query += ` AND content->>'${field}' = ANY($${paramIndex}::text[])`;
                                    params.push(value.$in);
                                    paramIndex++;
                                } else if (value.$ne) {
                                    // NOT EQUAL operator
                                    query += ` AND content->>'${field}' != $${paramIndex}`;
                                    params.push(value.$ne);
                                    paramIndex++;
                                }
                            } else {
                                // Simple equality
                                query += ` AND content->>'${field}' = $${paramIndex}`;
                                params.push(value);
                                paramIndex++;
                            }
                        } else if (path.length === 3) {
                            // Handle nested fields like content.metadata.source
                            const parent = path[1];
                            const child = path[2];
                            
                            query += ` AND content->'${parent}'->>'${child}' = $${paramIndex}`;
                            params.push(value);
                            paramIndex++;
                        }
                    }
                });
            }

            query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
            params.push(opts.count);

            // Enhanced logging for wallet registration queries
            if (opts.filter && (
                (opts.filter["content.type"] && opts.filter["content.type"].$eq === "wallet_registration") ||
                (opts.filter["content.type"] && opts.filter["content.type"].$eq === "pending_wallet_registration") ||
                (opts.filter["content.type"] === "wallet_registration") ||
                (opts.filter["content.type"] === "pending_wallet_registration")
            )) {
                elizaLogger.info("EXECUTING WALLET QUERY", {
                    operation: "getMemoriesWithLock",
                    sql: query,
                    params: JSON.stringify(params),
                    filter: JSON.stringify(opts.filter)
                });
            }

            const result = await this.adapter.query(query, params);
            const memories: Memory[] = result.rows.map(row => {
                // Ensure proper typing of the memory object
                return this.mapRowToMemory(row);
            });

            // Additional diagnostic logging for wallet registration queries
            if (opts.filter && (
                (opts.filter["content.type"] && opts.filter["content.type"].$eq === "wallet_registration") ||
                (opts.filter["content.type"] && opts.filter["content.type"].$eq === "pending_wallet_registration") ||
                (opts.filter["content.type"] === "wallet_registration") ||
                (opts.filter["content.type"] === "pending_wallet_registration")
            )) {
                const invalidMemories = memories.filter(m => {
                    // Check if memory has proper content structure before comparing
                    if (!m || typeof m !== 'object' || !('content' in m) || !m.content || typeof m.content !== 'object' || !('type' in m.content)) {
                        return true; // This is an invalid memory structure
                    }
                    
                    // Safe type comparison
                    const requestedType = 
                        typeof opts.filter["content.type"] === 'object' && opts.filter["content.type"].$eq 
                            ? opts.filter["content.type"].$eq 
                            : opts.filter["content.type"];
                    
                    return m.content.type !== requestedType;
                });
                
                if (invalidMemories.length > 0) {
                    elizaLogger.warn("FOUND INVALID RESULTS IN WALLET QUERY", {
                        foundCount: memories.length,
                        invalidCount: invalidMemories.length,
                        types: [...new Set(invalidMemories
                            .filter(m => m && typeof m === 'object' && 'content' in m && m.content && typeof m.content === 'object' && 'type' in m.content)
                            .map(m => (m.content as any).type))],
                        filter: JSON.stringify(opts.filter),
                        operation: "getMemoriesWithLock"
                    });
                } else {
                    elizaLogger.info("WALLET QUERY SUCCESSFUL", {
                        foundCount: memories.length,
                        operation: "getMemoriesWithLock"
                    });
                }
            }

            return memories as Memory[];
        } catch (error) {
            elizaLogger.error("Error in getMemoriesWithLock:", error);
            throw error;
        } finally {
            // Release lock
            await this.commitTransaction();
        }
    }

    /**
     * Legacy method required by BaseMemoryManager - delegates to checkAndEnforceUnique
     */
    protected async checkUniqueness(memory: Memory): Promise<boolean> {
        try {
            await this.checkAndEnforceUnique(memory);
            return false; // No existing memory found
        } catch (error) {
            if (error.message?.includes('already exists')) {
                return true; // Existing memory found
            }
            throw error; // Re-throw unexpected errors
        }
    }
} 