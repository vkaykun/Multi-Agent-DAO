// packages/plugin-solana/src/actions/tokeninfo.ts

import {
    Action,
    ActionExample,
    HandlerCallback,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { TokenProvider } from "../providers/token.ts";
import { WalletProvider } from "../providers/wallet.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import { ENDPOINTS } from "../endpoints.ts";
import { isValidSolanaAddress } from "../utils/commandValidation.ts";
import { validateActionCommand } from "../utils/governanceUtils.ts";
import { ExtendedAgentRuntime } from "../shared/utils/runtime.ts";

// Helper function to format numbers with commas and fixed decimals
function formatNumber(num: number, decimals: number = 2, abbreviate: boolean = false): string {
    if (abbreviate) {
        const abbreviations = [
            { value: 1e12, symbol: "T" },
            { value: 1e9, symbol: "B" },
            { value: 1e6, symbol: "M" },
            { value: 1e3, symbol: "K" }
        ];

        const item = abbreviations.find(item => num >= item.value);
        if (item) {
            return (num / item.value).toFixed(decimals) + item.symbol;
        }
    }

    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(num);
}

export const tokeninfo: Action = {
    name: "tokeninfo",
    description: "Get information about tokens, including price, volume, market cap, and liquidity",
    similes: [
        "token_price",
        "token_info",
        "price_check",
        "GET_CURRENT_PRICE_SOL",
        "price_sol",
        "token_volume",
        "token_liquidity",
        "market_cap",
        "token_stats",
        "token_metrics",
        "price_lookup",
        "price_query"
    ],
    examples: [],
    suppressInitialMessage: true,
    
    // DISABLED: This functionality is now disabled to prevent disruption in general conversation
    validate: async (runtime: ExtendedAgentRuntime, message: Memory) => {
        // Functionality disabled - always return false to prevent tokeninfo from processing any messages
        elizaLogger.debug("Tokeninfo functionality is disabled");
        return false;
    },
    
    handler: async (
        runtime: ExtendedAgentRuntime,
        message: Memory,
        state: State | undefined,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        // Function body preserved but never executed due to validate always returning false
        callback?.({
            text: "Token information functionality is currently disabled."
        });
        return false;
    }
};
