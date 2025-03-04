# Message Handling Utilities

This directory contains utilities for handling messages within the DAO agents system, with a focus on reliable and efficient operation.

## Message Deduplication System

The message deduplication system prevents storing the same message multiple times in the memory store. This resolves issues related to:

1. **Duplicate Content**: The same message being stored multiple times
2. **Inconsistent Storage**: Different methods creating slightly different versions of the same message
3. **Wasted Storage**: Unnecessary duplication of message content
4. **Query Confusion**: Difficulty determining which version of a message is the "canonical" one

### Key Components

- `messageUtils.ts`: Contains the core functions for message handling with deduplication
  - `storeUserMessageWithDeduplication()`: Handles storage with deduplication
  - `createMessageReference()`: Creates references to existing messages instead of duplicates
  - `safeExtractMessageText()`: Extracts text from various message formats

### How It Works

1. **In-Memory Tracking**: Maintains a set of already processed message IDs in memory
2. **Database Checking**: Checks if a message already exists in the database
3. **ID Generation**: Ensures every message has a stable, unique ID
4. **Reference System**: Creates references to existing messages instead of duplicating content

### Usage

Instead of calling `agent.storeUserMessage()` or `runtime.messageManager.createMemory()` directly, use:

```typescript
import { storeUserMessageWithDeduplication } from "../../shared/utils/messageUtils.ts";

// Store a message with deduplication
const messageId = await storeUserMessageWithDeduplication(
  runtime,
  message,
  agentId
);

// Create a reference to an existing message
const referenceId = await createMessageReference(
  runtime,
  originalMessageId,
  "proposal_reference",
  { proposalId: "123", context: "user discussion" },
  agentId
);
```

### Benefits

1. **Consistency**: Messages are stored in a consistent format
2. **Efficiency**: Reduces database storage requirements
3. **Reliability**: Prevents confusion about which message version to use
4. **Traceability**: Creates a clear hierarchy of original messages and references

## Implementation Notes

The message deduplication system has been implemented in:

1. `TreasuryAgent.storeUserMessage()`: Uses the centralized system
2. `messageHandler.handleMessage()`: Uses the centralized system for initial message processing
3. All command handlers: Use the centralized system for any secondary storage operations

When adding new handlers or agents that need to store user messages, always use the centralized system to maintain consistency and prevent duplication. 