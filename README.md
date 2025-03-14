# Vela v1

<img width="980" alt="Vela_v1" src="https://github.com/user-attachments/assets/6cea6d1a-84a5-4739-bc15-af397dc299ba" />

A distributed multi-agent system for autonomous DAO operations, featuring specialized agents who orchestrate treasury management, autonomous trading, and strategy execution, coupled with a governance framework for proposal creation, weighted voting, and automated execution of passed proposals. Agents communicate through an event-driven subscription system and unified ephemeral memory layer where each agent subscribes to memory types through a centralized subscription registry. The DAO *currently* operates within discord and allows users to interact with agents via natural language. The system is best described as a 'cybernetic-corp like entity in a box' and aims to progressively realize this concept by merging various protocols and 'network pieces' into a self-organizing human-machine network.

## Table of Contents
- [Architecture](#architecture)
- [Agents](#agents)
  - [ProposalAgent (Pion)](#proposalagent-pion)
  - [StrategyAgent (Kron)](#strategyagent-kron)
  - [TreasuryAgent (Vela)](#treasuryagent-vela)
  - [UserProfileAgent (Nova)](#userprofileagent-nova)
- [Core Components](#core-components)
  - [MemoryManager & ExtendedMemoryManager](#memorymanager--extendedmemorymanager)
  - [MemorySyncManager](#memorysyncmanager)
  - [MessageBroker](#messagebroker)
  - [Subscription Registry](#subscription-registry)
  - [BaseAgent and Shared Types](#baseagent-and-shared-types)
- [Scripts / Entry Points](#scripts--entry-points)
  - [startVela.ts](#startvelets-treasuryagent)
- [Communication Flow](#communication-flow)
- [How to Run Locally](#how-to-run-locally)
- [Directory Structure](#directory-structure)

The four primary agents in this system are ProposalAgent (Pion), StrategyAgent (Kron), TreasuryAgent (Vela), and UserProfileAgent (Nova).

Key points:

- Each agent is an instance of the BaseAgent class.
- MemoryManager + MessageBroker + MemorySyncManager provide a robust communication and storage system.
- Agents are run in separate processes, each connecting to a Postgres DB and via cross-process messages.
- A subscription registry ensures each agent only receives relevant memory updates.

## Agents

### TreasuryAgent (Vela)

Key Features:

- Core Treasury operations: user registration, treasury deposits, transfers, token swaps (upon community consensus).
- Agents TEE-controlled wallet acts as a 'treasury'.
- Serves as the bridge between on-chain actions and the rest of the DAO.

### ProposalAgent (Pion)

Key Features:

- Creates new proposals with unique IDs by interpreting user requests, validating input, and scheduling votes.
- Auto-detects user votes from messages "yes/no" or emoji reactions '✅'.
- Monitors and manages the entire proposal lifecycle: open → pending_execution → executing → executed or failed.
- TreasuryAgent or strategyAgent automatically execute passed proposals when quorum is reached.
- Uses DistributedLock to avoid concurrent updates on the same proposal.


### StrategyAgent (Kron)

Key Features:

- Manages advanced trading strategies for tokens, e.g.:
- Take-profit (TP) levels, stop-loss (SL), trailing stop, DCA, grids, rebalancing.
- Position tracking: opens or updates positions based on user instructions or proposals.
- treasuryAgent triggers token swaps when conditions are met as dictated by the strategyAgent (e.g., price threshold).
- Users simply define a strategy in natural language for a [articular open trade (e.g. set a take profit at 30% for position 'X').


### UserProfileAgent (Nova)

Key Features:

- Manages user profiles, reputations, preferences, tasks, and other conversation-based data.
- Modular to support various goverance mechanisms and quorum rules; liquid democracy, quadratic voting.
- Can handle user-level permission checks, roles (admin, moderator, user).

## Core Components

### MemoryManager & ExtendedMemoryManager
Files:

- packages/plugin-solana/src/shared/memory/BaseMemoryManager.ts
- packages/plugin-solana/src/shared/utils/runtime.ts (where ExtendedMemoryManager is constructed)

Function:

- Provides read/write operations for storing Memory objects in a database.
- Handles "versioned" memory types (like proposals) and unique memory constraints.
- Agents rely on it to createMemory, getMemories, subscribeToMemory, etc.
- ExtendedMemoryManager is a specialized overlay that enriches the base memory manager with additional logic like locks, concurrency checks, or advanced search.

### MemorySyncManager
File: packages/plugin-solana/src/shared/memory/MemorySyncManager.ts

Function:

- Synchronizes memory changes across multiple processes.
- Listens for create/update/delete events and replicates them, ensuring all agent processes share consistent state.
- Uses inter-process messaging (process.send in Node.js) or a custom bus mechanism.

### MessageBroker
File: packages/plugin-solana/src/shared/MessageBroker.ts

Function:

- A local event emitter that broadcasts memory events to in-process subscribers.
- Agents subscribe to memory types (e.g., "proposal_created"), and the MessageBroker routes relevant events.
- Works in tandem with MemorySyncManager for cross-process broadcasting.

### Subscription Registry
File:

- packages/plugin-solana/src/shared/types/subscriptionRegistry.ts
- packages/plugin-solana/src/shared/types/memory-subscriptions.ts

Function:

- Enumerates which memory types each agent must subscribe to. E.g., the ProposalAgent must subscribe to vote_cast, proposal_created, etc.
- Ensures an agent only handles the relevant memory events, thereby simplifying the logic.

### BaseAgent and Shared Types
File: packages/plugin-solana/src/shared/BaseAgent.ts

Key Elements:

- BaseAgent is the abstract class providing common functionality:
  - Lifecycle methods: initialize(), shutdown().
  - Transaction helpers: withTransaction().
  - Subscriptions, cross-process event hooking.
- AgentMessage, BaseContent, Room IDs, DistributedLock interfaces are also defined in types/base.ts.

## Scripts / Entry Points
There are four main script files, each starting one of the specialized agents:

### e.g. startVela.ts (TreasuryAgent)
- Path: packages/plugin-solana/src/startVela.ts
- Bootstraps the TreasuryAgent to handle all treasury-related commands (deposits, swaps, balance checks, etc.).

## Communication Flow Example (for treasuryAgent):
1. User types in chat (e.g., "i want to register my wallet <addresss>", "how do i deposit?", "i propose we swap 20 SOL for USDC".
2. Agents capture the a Memory of type user_message.
3. MemoryManager triggers a local event → MessageBroker broadcasts → The agent responsible for that memory type picks it up.
4. E.g., if the message is a deposit command, TreasuryAgent sees it and processes it.
5. The agent performs logic (maybe a swap, a deposit verification, or schedule a proposal).
6. Any changes are stored as new Memory records (proposal_created, vote_cast, strategy_execution_request, etc.).
7. The MemorySyncManager replicates the event to other processes if in multi-process mode.
8. Other agents listen to relevant memory types, e.g., the StrategyAgent might see a proposal_passed memory, or the ProposalAgent sees a vote_cast.

## How to Run Locally
### Install dependencies
```bash
npm install
```

### Set environment variables
- Copy .env.example to .env and fill in Solana or DB credentials.
- Create specialized .env files for each agent each agent.

### Run an agent
Example: to start the TreasuryAgent (Vela):
```bash
ts-node packages/plugin-solana/src/startVela.ts
```
or the ProposalAgent (Pion):
```bash
ts-node packages/plugin-solana/src/startPion.ts
```

### Multi-process
Simply run each script in a separate terminal (or a process manager). The MemorySyncManager will keep them in sync if MULTI_PROCESS=true.

## Directory Structure (High-Level)
```
packages/plugin-solana/src/
├── agents/
│   ├── proposal/
│   │   └── ProposalAgent.ts      # Pion
│   ├── strategy/
│   │   └── StrategyAgent.ts      # Kron
│   ├── treasury/
│   │   └── TreasuryAgent.ts      # Vela
│   └── user/
│       └── UserProfileAgent.ts   # Nova
├── shared/
│   ├── memory/
│   │   ├── BaseMemoryManager.ts
│   │   ├── MemorySyncManager.ts
│   │   └── ...
│   ├── types/
│   │   ├── base.ts
│   │   ├── memory-subscriptions.ts
│   │   ├── subscriptionRegistry.ts
│   │   └── ...
│   ├── MessageBroker.ts
│   └── ...
├── startPion.ts       # Boot script for ProposalAgent
├── startKron.ts       # Boot script for StrategyAgent
├── startVela.ts       # Boot script for TreasuryAgent
├── startNova.ts       # Boot script for UserProfileAgent
└── ...
```

This project is built on top of [ElizaOS](https://github.com/elizaOS/eliza) with significant modifications to the core framework.
