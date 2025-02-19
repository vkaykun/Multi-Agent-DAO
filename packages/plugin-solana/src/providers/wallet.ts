import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { toBN, BigNumber } from "../utils/bignumber.js";
import NodeCache from "node-cache";
import { getWalletKey } from "../keypairUtils.js";

// Provider configuration
const PROVIDER_CONFIG = {
    BIRDEYE_API: "https://public-api.birdeye.so",
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
    DEFAULT_RPC: "https://api.mainnet-beta.solana.com",
    GRAPHQL_ENDPOINT: "https://graph.codex.io/graphql",
    TOKEN_ADDRESSES: {
        SOL: "So11111111111111111111111111111111111111112",
        BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
        ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    },
};

export interface Item {
    name: string;
    address: string;
    symbol: string;
    decimals: number;
    balance: string;
    uiAmount: string;
    priceUsd: string;
    valueUsd: string;
    valueSol?: string;
}

interface WalletPortfolio {
    totalUsd: string;
    totalSol?: string;
    items: Array<Item>;
}

interface Prices {
    solana: { usd: string };
    bitcoin: { usd: string };
    ethereum: { usd: string };
}

interface GraphQLResponse {
    data?: {
        data?: {
            balances?: {
                items?: any[];
            };
        };
    };
}

export class WalletProvider {
    private cache: NodeCache;

    constructor(
        private connection: Connection,
        private walletPublicKey: PublicKey
    ) {
        this.cache = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes
    }

    private async fetchWithRetry(
        runtime: IAgentRuntime,
        url: string,
        options: RequestInit = {}
    ): Promise<any> {
        let lastError: Error = new Error("Request failed");

        for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
            try {
                const response = await fetch(url, {
                    ...options,
                    headers: {
                        Accept: "application/json",
                        "x-chain": "solana",
                        "X-API-KEY":
                            runtime.getSetting("BIRDEYE_API_KEY") || "",
                        ...options.headers,
                    },
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(
                        `HTTP error! status: ${response.status}, message: ${errorText}`
                    );
                }

                const data = await response.json();
                return data;
            } catch (error) {
                elizaLogger.error(`Attempt ${i + 1} failed:`, error);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
                    const delay = PROVIDER_CONFIG.RETRY_DELAY * Math.pow(2, i);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
            }
        }

        elizaLogger.error(
            "All attempts failed. Throwing the last error:",
            lastError
        );
        throw lastError;
    }

    async fetchPortfolioValue(runtime: IAgentRuntime): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.walletPublicKey.toBase58()}`;
            const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);

            if (cachedValue) {
                elizaLogger.log("Cache hit for fetchPortfolioValue");
                return cachedValue;
            }
            elizaLogger.log("Cache miss for fetchPortfolioValue");

            // Always use basic token account info without Birdeye
            const accounts = await this.getTokenAccounts(
                this.walletPublicKey.toBase58()
            );

            const items = accounts.map((acc) => ({
                name: "Unknown",
                address: acc.account.data.parsed.info.mint,
                symbol: "Unknown",
                decimals: acc.account.data.parsed.info.tokenAmount.decimals,
                balance: acc.account.data.parsed.info.tokenAmount.amount,
                uiAmount:
                    acc.account.data.parsed.info.tokenAmount.uiAmount.toString(),
                priceUsd: "0",
                valueUsd: "0",
                valueSol: "0",
            }));

            const portfolio = {
                totalUsd: "0",
                totalSol: "0",
                items,
            };

            this.cache.set(cacheKey, portfolio);
            return portfolio;
        } catch (error) {
            elizaLogger.error("Error fetching portfolio:", error);
            throw error;
        }
    }

    async fetchPortfolioValueCodex(runtime: IAgentRuntime): Promise<WalletPortfolio> {
        try {
            const cacheKey = `portfolio-${this.walletPublicKey.toBase58()}`;
            const cachedValue = await this.cache.get<WalletPortfolio>(cacheKey);

            if (cachedValue) {
                elizaLogger.log("Cache hit for fetchPortfolioValue");
                return cachedValue;
            }
            elizaLogger.log("Cache miss for fetchPortfolioValue");

            const query = `
              query Balances($walletId: String!, $cursor: String) {
                balances(input: { walletId: $walletId, cursor: $cursor }) {
                  cursor
                  items {
                    walletId
                    tokenId
                    balance
                    shiftedBalance
                  }
                }
              }
            `;

            const variables = {
                walletId: `${this.walletPublicKey.toBase58()}:${1399811149}`,
                cursor: null,
            };

            const response = await fetch(PROVIDER_CONFIG.GRAPHQL_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization:
                        runtime.getSetting("CODEX_API_KEY") || "",
                },
                body: JSON.stringify({
                    query,
                    variables,
                }),
            }).then((res) => res.json()) as GraphQLResponse;

            const data = response.data?.data?.balances?.items;

            if (!data || data.length === 0) {
                elizaLogger.error("No portfolio data available", data);
                throw new Error("No portfolio data available");
            }

            // Fetch token prices
            const prices = await this.fetchPrices(runtime);
            const solPriceInUSD = toBN(prices.solana.usd.toString());

            // Reformat items
            const items: Item[] = data.map((item: any) => {
                return {
                    name: "Unknown",
                    address: item.tokenId.split(":")[0],
                    symbol: item.tokenId.split(":")[0],
                    decimals: 6,
                    balance: item.balance,
                    uiAmount: item.shiftedBalance.toString(),
                    priceUsd: "",
                    valueUsd: "",
                    valueSol: "",
                };
            });

            // Calculate total portfolio value
            const totalUsd = items.reduce(
                (sum, item) => sum.plus(toBN(item.valueUsd)),
                toBN(0)
            );

            const totalSol = totalUsd.div(solPriceInUSD);

            const portfolio: WalletPortfolio = {
                totalUsd: totalUsd.toFixed(6),
                totalSol: totalSol.toFixed(6),
                items: items.sort((a: Item, b: Item) =>
                    toBN(b.valueUsd)
                        .minus(toBN(a.valueUsd))
                        .toNumber()
                ),
            };

            // Cache the portfolio for future requests
            await this.cache.set(cacheKey, portfolio, 60 * 1000); // Cache for 1 minute

            return portfolio;
        } catch (error) {
            elizaLogger.error("Error fetching portfolio:", error);
            throw error;
        }
    }

    async fetchPrices(runtime: IAgentRuntime): Promise<Prices> {
        try {
            const cacheKey = "prices";
            const cachedValue = this.cache.get<Prices>(cacheKey);

            if (cachedValue) {
                elizaLogger.log("Cache hit for fetchPrices");
                return cachedValue;
            }
            elizaLogger.log("Cache miss for fetchPrices");

            const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
            const tokens = [SOL, BTC, ETH];
            const prices: Prices = {
                solana: { usd: "0" },
                bitcoin: { usd: "0" },
                ethereum: { usd: "0" },
            };

            for (const token of tokens) {
                const response = await this.fetchWithRetry(
                    runtime,
                    `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`,
                    {
                        headers: {
                            "x-chain": "solana",
                        },
                    }
                );

                if (response?.data?.value) {
                    const price = response.data.value.toString();
                    prices[
                        token === SOL
                            ? "solana"
                            : token === BTC
                              ? "bitcoin"
                              : "ethereum"
                    ].usd = price;
                } else {
                    elizaLogger.warn(
                        `No price data available for token: ${token}`
                    );
                }
            }

            this.cache.set(cacheKey, prices);
            return prices;
        } catch (error) {
            elizaLogger.error("Error fetching prices:", error);
            throw error;
        }
    }

    formatPortfolio(
        portfolio: WalletPortfolio,
        prices: Prices
    ): string {
        let output = `Wallet Address: ${this.walletPublicKey.toBase58()}\n\n`;

        const totalUsdFormatted = toBN(portfolio.totalUsd).toFixed(2);
        const totalSolFormatted = portfolio.totalSol;

        output += `Total Value: $${totalUsdFormatted} (${totalSolFormatted} SOL)\n\n`;
        output += "Token Balances:\n";

        const nonZeroItems = portfolio.items.filter((item) =>
            toBN(item.uiAmount).isGreaterThan(0)
        );

        if (nonZeroItems.length === 0) {
            output += "No tokens found with non-zero balance\n";
        } else {
            for (const item of nonZeroItems) {
                const valueUsd = toBN(item.valueUsd).toFixed(2);
                output += `${item.name} (${item.symbol}): ${toBN(
                    item.uiAmount
                ).toFixed(6)} ($${valueUsd} | ${item.valueSol} SOL)\n`;
            }
        }

        output += "\nMarket Prices:\n";
        output += `SOL: $${toBN(prices.solana.usd).toFixed(2)}\n`;
        output += `BTC: $${toBN(prices.bitcoin.usd).toFixed(2)}\n`;
        output += `ETH: $${toBN(prices.ethereum.usd).toFixed(2)}\n`;

        return output;
    }

    async getFormattedPortfolio(runtime: IAgentRuntime): Promise<string> {
        try {
            const [portfolio, prices] = await Promise.all([
                this.fetchPortfolioValue(runtime),
                this.fetchPrices(runtime),
            ]);

            return this.formatPortfolio(portfolio, prices);
        } catch (error) {
            elizaLogger.error("Error generating portfolio report:", error);
            return "Unable to fetch wallet information. Please try again later.";
        }
    }

    private async getTokenAccounts(walletAddress: string) {
        try {
            const accounts =
                await this.connection.getParsedTokenAccountsByOwner(
                    new PublicKey(walletAddress),
                    {
                        programId: new PublicKey(
                            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
                        ),
                    }
                );
            return accounts.value;
        } catch (error) {
            elizaLogger.error("Error fetching token accounts:", error);
            return [];
        }
    }
}

const walletProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            const { publicKey } = await getWalletKey(runtime, false);
            if (!publicKey) {
                return "Error: No wallet key available";
            }

            const connection = new Connection(
                runtime.getSetting("SOLANA_RPC_URL") ||
                    PROVIDER_CONFIG.DEFAULT_RPC
            );

            const provider = new WalletProvider(connection, publicKey);

            return await provider.getFormattedPortfolio(runtime);
        } catch (error) {
            elizaLogger.error("Error in wallet provider:", error);
            return null;
        }
    },
};

// Module exports
export { walletProvider };
