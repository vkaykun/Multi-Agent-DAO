// packages/plugin-solana/src/utils/strategyParser.ts

import { elizaLogger } from "@elizaos/core";
import { StrategyConfig } from "../providers/positionTracker.js";

const TP_VARIATIONS = [
    'tp at',
    'tp',
    'take profit at',
    'take profit',
    'target at',
    'target',
    'sell at',
    't/p at',
    't/p'
];

const SL_VARIATIONS = [
    'sl at',
    'sl',
    'stop loss at',
    'stop loss',
    'stop at',
    'stop',
    's/l at',
    's/l'
];

const TRAILING_VARIATIONS = [
    'trailing',
    'trailing stop',
    'trailing sl',
    'trailing stop loss',
    'ts',
    't/s'
];

// Add split variations
const SPLIT_VARIATIONS = [
    'sell',
    'split',
    'size'
];

function createVariationPattern(variations: string[]): string {
    return variations.map(v => v.replace('/', '\\/')).join('|');
}

export async function parseNaturalLanguageStrategy(text: string, entryPrice: number): Promise<StrategyConfig | null> {
    try {
        const strategy: StrategyConfig = {
            takeProfitLevels: []
        };

        const normalizedText = text.toLowerCase()
            .replace(/[,]/g, ' ') 
            .replace(/\s+/g, ' ') 
            .replace(/(\d+)%/g, '$1 %') 
            .replace(/\(/g, ' ')  
            .replace(/\)/g, ' ')
            .trim();

        const tpPattern = new RegExp(`(?:${createVariationPattern(TP_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%(?:\\s*(?:${createVariationPattern(SPLIT_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%)?`, 'g');
        const trailingPattern = new RegExp(`(?:${createVariationPattern(TRAILING_VARIATIONS)})(?:\\s+stop)?(?:\\s+at)?\\s*(\\d*\\.?\\d+)\\s*%`);
        const slPattern = new RegExp(`(?:${createVariationPattern(SL_VARIATIONS)})\\s*(\\d*\\.?\\d+)\\s*%`);

        const tpMatches = Array.from(normalizedText.matchAll(tpPattern));
        let remainingSellAmount = 100; 

        if (tpMatches.length > 0) {
            for (const match of tpMatches) {
                const percentage = parseFloat(match[1]);
                let sellAmount: number;

                if (match[2]) {
                    sellAmount = parseFloat(match[2]);
                    if (sellAmount > remainingSellAmount) {
                        sellAmount = remainingSellAmount;
                    }
                } else {

                    sellAmount = Math.floor(remainingSellAmount / (tpMatches.length - strategy.takeProfitLevels.length));
                }

                if (!isNaN(percentage) && percentage > 0 && sellAmount > 0) {
                    strategy.takeProfitLevels.push({
                        percentage,
                        price: entryPrice * (1 + (percentage / 100)),
                        sellAmount
                    });
                    remainingSellAmount -= sellAmount;
                }

                if (remainingSellAmount <= 0) break;
            }

            if (remainingSellAmount > 0 && strategy.takeProfitLevels.length > 0) {
                strategy.takeProfitLevels[strategy.takeProfitLevels.length - 1].sellAmount += remainingSellAmount;
            }
        }

        const trailingMatch = normalizedText.match(trailingPattern);
        if (trailingMatch) {
            const percentage = parseFloat(trailingMatch[1]);
            if (!isNaN(percentage) && percentage > 0) {
                strategy.stopLoss = {
                    percentage,
                    price: entryPrice * (1 - (percentage / 100)),
                    isTrailing: true,
                    trailingDistance: percentage,
                    highestPrice: entryPrice
                };
            }
        } else {
            const slMatch = normalizedText.match(slPattern);
            if (slMatch) {
                const percentage = parseFloat(slMatch[1]);
                if (!isNaN(percentage) && percentage > 0) {
                    strategy.stopLoss = {
                        percentage,
                        price: entryPrice * (1 - (percentage / 100)),
                        isTrailing: false
                    };
                }
            }
        }

        if (strategy.takeProfitLevels.length === 0 && !strategy.stopLoss) {
            elizaLogger.debug("No valid take profit or stop loss levels found");
            return null;
        }

        strategy.takeProfitLevels.sort((a, b) => a.percentage - b.percentage);

        elizaLogger.debug("Parsed strategy:", {
            strategy,
            entryPrice,
            text,
            normalizedText
        });
        return strategy;

    } catch (error) {
        elizaLogger.error("Error parsing strategy:", error);
        return null;
    }
}

export function formatStrategyDetails(strategy: StrategyConfig): string {
    let details = '';

    if (strategy.takeProfitLevels.length > 0) {
        details += '\nTake Profit Levels:';
        strategy.takeProfitLevels.forEach((tp, index) => {
            details += `\n${index + 1}. ${tp.percentage}% (Sell ${tp.sellAmount}%)`;
            if (tp.price) {
                details += ` at $${tp.price.toFixed(4)}`;
            }
        });
    }

    if (strategy.stopLoss) {
        if (strategy.stopLoss.isTrailing) {
            details += `\nTrailing Stop: ${strategy.stopLoss.trailingDistance}% below highest price`;
            if (strategy.stopLoss.price) {
                details += `\nInitial stop price: $${strategy.stopLoss.price.toFixed(4)}`;
            }
        } else {
            details += `\nStop Loss: ${strategy.stopLoss.percentage}%`;
            if (strategy.stopLoss.price) {
                details += ` at $${strategy.stopLoss.price.toFixed(4)}`;
            }
        }
    }

    return details;
}
