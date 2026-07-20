/**
 * Reasoning and tool-call cost accounting (G03 / SPEC-024).
 *
 * Extends the input/cached/output cost (SPEC-023) with reasoning tokens (billed
 * at the reasoning rate, falling back to the output rate) and per-tool-call
 * charges, producing the full cost of a `TokenUsage`. Integer nano-USD, pure.
 */
import type { ProviderPrice } from '../providers/pricing/registry';
import { costForTokens, perMTokCost, type CostBreakdown } from './cost-calc';
import type { TokenUsage } from './tokens';

export interface FullCostBreakdown extends CostBreakdown {
  reasoningNanoUsd: number;
  toolCallsNanoUsd: number;
}

/** Full priced cost of a TokenUsage against a provider price. */
export function costForUsage(price: ProviderPrice, usage: TokenUsage): FullCostBreakdown {
  const base = costForTokens(price, {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
  });

  // Reasoning tokens: use the reasoning rate if published, else the output rate
  // (reasoning is output-side generation). Only meaningful for per_mtok models.
  const reasoningRate =
    price.unit === 'per_mtok' ? price.reasoningNanoUsdPerMTok ?? price.outputNanoUsdPerMTok : undefined;
  const reasoningNanoUsd = perMTokCost(usage.reasoningTokens, reasoningRate);

  const toolCallsNanoUsd = Math.max(0, usage.toolCalls) * (price.perToolCallNanoUsd ?? 0);

  return {
    ...base,
    reasoningNanoUsd,
    toolCallsNanoUsd,
    totalNanoUsd: base.totalNanoUsd + reasoningNanoUsd + toolCallsNanoUsd,
  };
}
