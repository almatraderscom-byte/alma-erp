/**
 * Pre-call cost estimators (G03 / SPEC-025 normal, SPEC-026 worst-case).
 *
 * Produce a nano-USD estimate BEFORE a model call so the Cost Governor (G04) can
 * authorise or reject against a budget. `normal` uses expected usage; `worst`
 * assumes the upper bound (max output/reasoning, no cache benefit). Pure.
 */
import type { ProviderPrice } from '../providers/pricing/registry';
import type { TokenUsage } from './tokens';
import { EMPTY_USAGE } from './tokens';
import { costForUsage, type FullCostBreakdown } from './usage-cost';

export type EstimateBasis = 'normal' | 'worst_case';

export interface CostEstimate {
  provider: string;
  model: string;
  basis: EstimateBasis;
  nanoUsd: number;
  breakdown: FullCostBreakdown;
  priceVerified: boolean; // surfaces that the underlying price is an estimate
}

/** Normal pre-call estimate from expected usage (SPEC-025). */
export function estimateNormalCost(price: ProviderPrice, usage: TokenUsage): CostEstimate {
  const breakdown = costForUsage(price, usage);
  return {
    provider: price.provider,
    model: price.model,
    basis: 'normal',
    nanoUsd: breakdown.totalNanoUsd,
    breakdown,
    priceVerified: price.verified,
  };
}

export interface WorstCaseBounds {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxReasoningTokens?: number;
  maxToolCalls?: number;
}

/**
 * Worst-case pre-call estimate (SPEC-026): the upper bound the Cost Governor
 * must be able to afford. Assumes NO cache benefit (all input at full rate) and
 * the maximum output/reasoning/tool budget. Never less than the normal estimate
 * for the same token counts.
 */
export function estimateWorstCaseCost(price: ProviderPrice, bounds: WorstCaseBounds): CostEstimate {
  const worstUsage: TokenUsage = {
    ...EMPTY_USAGE,
    inputTokens: Math.max(0, bounds.maxInputTokens),
    cachedInputTokens: 0, // worst case: nothing is cached
    outputTokens: Math.max(0, bounds.maxOutputTokens),
    reasoningTokens: Math.max(0, bounds.maxReasoningTokens ?? 0),
    toolCalls: Math.max(0, bounds.maxToolCalls ?? 0),
  };
  const breakdown = costForUsage(price, worstUsage);
  return {
    provider: price.provider,
    model: price.model,
    basis: 'worst_case',
    nanoUsd: breakdown.totalNanoUsd,
    breakdown,
    priceVerified: price.verified,
  };
}
