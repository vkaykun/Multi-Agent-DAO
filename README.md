# Vela-v1

<img width="984" alt="vela1" src="https://github.com/user-attachments/assets/f50a6ada-16a7-45f0-8c6c-28079ee05c0a" />

A distributed multi-agent system for fully autonomous DAO operations on Solana, featuring specialized agents for treasury management, autonomous trading, strategy execution, coupled with a reputation-based governance framework for proposal creation, voting, and automated execution of passed proposals. The system supports consensus mechanisms such as liquid democracy and quadratic voting for decision making, and reputation-based weighted voting. Agents communicate through an event-driven subscription system, where each agent subscribes to specific memory types through a centralized registry. The DAO operates within discord and is best described as a 'cybernetic corp-like entity in a box'

This project is a fork of [ElizaOS](https://github.com/elizaOS/eliza) with modifications to the existing Solana plugin.

## Agents:

Vela (Treasury Agent)

* Manages treasury through TEE-controlled wallet: deposits, withdrawals, and token swaps.
* Automatically executes treasury-related decisions once proposals pass.

Pion (Governance Agent)

* Oversees proposal creation and voting.
* Collects weighted votes (based on Nova’s reputation system).
* Finalizes proposals (open → closed → executed or rejected) and enforces quorum/threshold rules.

Kron (Strategy Agent)

* Parses natural-language trading/yield strategies (e.g., “take profit at 20%”).
* Monitors markets and triggers trade signals when conditions are met.
* Signals are sent to the Vela agent to execute trades.

Nova (User Profile Agent)

* Maintains user profiles, reputation points, and voting weights.
* Adjusts reputation for contributions and various DAO-defined criteria.
* Supplies weighted voting data to Pion for governance decisions.


## Memory Architecture

* Universal memory space with typed content and room-based partitioning
* "Global DAO Rooms" for shared state between agents
* Cross-process memory convergence via MemorySyncManager
* Transaction-based state transitions with ACID guarantees

### Subscription Registry
* Centralized registry (`SUBSCRIPTION_REGISTRY`) mapping agent types to memory event types
* Enables cross-agent communication through memory event subscriptions
* Defines required memory types each agent must handle (e.g., TreasuryAgent subscribes to `swap_request`, `deposit_received`, etc.)

### MessageBroker
* Implements publisher-subscriber pattern for local event broadcasting
* Ensures reliable delivery of DAO events to all interested agents

## State Machines

### Memory
```bash
EPHEMERAL → PERSISTENT → ARCHIVED
```

### Content
```bash
DRAFT → PENDING → EXECUTED | FAILED
```

### Process
```bash
INIT → ACTIVE → MONITORING → TERMINATED
```

## Implementation

### Core Dependencies

* Node.js 23.3.0
* PostgreSQL
* Solana CLI
* pnpm 9.15.0

### Runtime Configuration

```bash
# Agent-specific environment initialization for specialized agents
cp packages/plugin-solana/.env.example packages/plugin-solana/.env.[agent]

# DB initialization
createdb dao_dev
pnpm run migrate
```

### Process Initialization

```bash
# Distributed process startup across multiple agents
pnpm run start:vela
pnpm run start:kron
pnpm run start:pion
pnpm run start:nova
```


