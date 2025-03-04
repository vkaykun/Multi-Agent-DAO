import { elizaLogger } from "@elizaos/core";

/**
 * Interface defining the minimal requirements for a transaction manager
 */
export interface TransactionManager {
  beginTransaction: () => Promise<void>;
  commitTransaction: () => Promise<void>;
  rollbackTransaction: () => Promise<void>;
  isInTransaction: boolean;
  getTransactionLevel: () => number;
}

/**
 * Executes a function within a transaction context
 * 
 * @param manager - A transaction manager implementing begin/commit/rollback transaction methods
 * @param executor - The function to execute within the transaction
 * @returns The result of the executor function
 */
export async function withTransaction<T>(
  manager: TransactionManager,
  executor: () => Promise<T>
): Promise<T> {
  if (!manager) {
    elizaLogger.warn("No transaction manager provided, executing without transaction support");
    return executor();
  }

  try {
    // Begin transaction
    await manager.beginTransaction();
    
    // Execute the provided function
    const result = await executor();
    
    // Commit transaction
    await manager.commitTransaction();
    
    return result;
  } catch (error) {
    // Rollback transaction on error
    try {
      if (manager.isInTransaction) {
        await manager.rollbackTransaction();
        elizaLogger.warn("Transaction rolled back due to error", { 
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } catch (rollbackError) {
      elizaLogger.error("Error during transaction rollback", {
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        originalError: error instanceof Error ? error.message : String(error)
      });
    }
    
    // Re-throw the original error
    throw error;
  }
}

/**
 * Creates a transaction manager that wraps any object with transaction-like methods
 * 
 * @param manager - The memory manager to wrap
 * @returns A transaction manager
 */
export function createTransactionManager(
  manager: any
): TransactionManager {
  if (!manager) {
    elizaLogger.warn("No memory manager provided, using no-op transaction manager");
    return createNoOpTransactionManager();
  }

  // Check if the manager has the required transaction methods
  const hasBeginTransaction = typeof manager.beginTransaction === 'function';
  const hasCommitTransaction = typeof manager.commitTransaction === 'function';
  const hasRollbackTransaction = typeof manager.rollbackTransaction === 'function';
  
  if (!hasBeginTransaction || !hasCommitTransaction || !hasRollbackTransaction) {
    elizaLogger.warn("Memory manager does not support transactions, using no-op transaction manager", {
      hasBeginTransaction,
      hasCommitTransaction,
      hasRollbackTransaction
    });
    return createNoOpTransactionManager();
  }

  // Return a transaction manager that delegates to the memory manager
  return {
    beginTransaction: async () => {
      try {
        await manager.beginTransaction();
      } catch (error) {
        elizaLogger.error("Error beginning transaction", { 
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
    commitTransaction: async () => {
      try {
        await manager.commitTransaction();
      } catch (error) {
        elizaLogger.error("Error committing transaction", { 
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
    rollbackTransaction: async () => {
      try {
        await manager.rollbackTransaction();
      } catch (error) {
        elizaLogger.error("Error rolling back transaction", { 
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    },
    isInTransaction: 'isInTransaction' in manager ? !!manager.isInTransaction : false,
    getTransactionLevel: () => {
      if ('getTransactionLevel' in manager && typeof manager.getTransactionLevel === 'function') {
        return manager.getTransactionLevel();
      }
      // Default to assuming we're at transaction level 0 if not in a transaction,
      // or level 1 if we know we're in a transaction but don't know the exact level
      return 'isInTransaction' in manager && manager.isInTransaction ? 1 : 0;
    }
  };
}

/**
 * Creates a no-op transaction manager that doesn't actually perform
 * transaction operations but provides the same interface
 * 
 * @returns A no-op transaction manager
 */
function createNoOpTransactionManager(): TransactionManager {
  return {
    beginTransaction: async () => {
      elizaLogger.debug("No-op transaction manager: beginTransaction called");
    },
    commitTransaction: async () => {
      elizaLogger.debug("No-op transaction manager: commitTransaction called");
    },
    rollbackTransaction: async () => {
      elizaLogger.debug("No-op transaction manager: rollbackTransaction called");
    },
    isInTransaction: false,
    getTransactionLevel: () => 0
  };
} 