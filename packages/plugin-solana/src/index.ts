// packages/plugin-solana/src/index.ts

export * from "./providers/token.js";
export * from "./providers/wallet.js";
export * from "./evaluators/trust.js";

import type { Plugin } from "@elizaos/core";
import { IAgentRuntime, elizaLogger, stringToUuid, UUID, Memory, State, ServiceType, HandlerCallback, Validator } from "@elizaos/core";
import { TokenProvider } from "./providers/token.js";
import { WalletProvider } from "./providers/wallet.js";
import { getTokenBalance, getTokenBalances } from "./providers/tokenUtils.js";
import { walletProvider } from "./providers/wallet.js";

// Comment out action handler imports since we're using agents
// import { register } from "./actions/register.js";
// import { deposit } from "./actions/deposit.js";
// import { balance } from "./actions/balance.js";
// import { verify } from "./actions/verify.js";
// import { executeSwap } from "./actions/swap.js";
// import transfer from "./actions/transfer.js";
// import { tokeninfo } from "./actions/tokeninfo.js";
// import { propose } from "./actions/propose.js";
// import { vote } from "./actions/vote.js";
// import { closeVote, startProposalMonitoring } from "./actions/closeVote.js";
// import cancelStrategy from "./actions/cancelStrategy.js";
// import { checkProposalStatus } from "./actions/checkProposalStatus.js";
// import { createAndBuyToken, buyPumpToken, CreateAndBuyContent, isCreateAndBuyContent } from "./actions/pumpfun.js";
// import { strategy } from "./actions/strategy.js";

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { BaseAgent } from "./shared/BaseAgent";
import {
    AgentType,
    AgentMessage,
    BaseContent,
    CHARACTER_AGENT_MAPPING,
    CharacterName
} from "./shared/types/base";
import { StrategyContent } from "./shared/types/strategy.js";
import { MessageBroker } from './shared/MessageBroker';
import { PumpFunSDK } from "pumpdotfun-sdk";

const require = createRequire(import.meta.url);

// Export core functionality
export {
    TokenProvider,
    WalletProvider,
    getTokenBalance,
    getTokenBalances,
    walletProvider,
    BaseAgent
};

// Comment out action handler exports since we're using agents
// export {
//     register,
//     deposit,
//     balance,
//     verify,
//     executeSwap,
//     transfer,
//     tokeninfo,
//     propose,
//     vote,
//     closeVote,
//     startProposalMonitoring,
//     cancelStrategy,
//     checkProposalStatus,
//     createAndBuyToken,
//     buyPumpToken,
//     strategy
// };

// Export types
export type {
    AgentType,
    AgentMessage,
    BaseContent,
    StrategyContent,
    CharacterName
};

// Export constants and utilities
export {
    CHARACTER_AGENT_MAPPING,
    MessageBroker
};

// Add function to validate Solana addresses
export function validateSolanaAddress(address: string): boolean {
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

// Export plugin configuration
export default {
    name: "solana",
    description: "Solana Plugin for Eliza",
    actions: [],
    evaluators: [],
    services: []
} satisfies Plugin;