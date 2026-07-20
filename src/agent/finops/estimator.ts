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
