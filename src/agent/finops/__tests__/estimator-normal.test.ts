import { describe, it, expect } from 'vitest';
import { estimateNormalCost } from '../estimator';
import { EMPTY_USAGE } from '../tokens';
import { getPrice, usdToNano } from '../../providers/pricing/registry';

const gemini = getPrice('google', 'gemini-3.1-pro')!;

describe('estimateNormalCost (SPEC-025)', () => {
  it('estimates from expected usage and matches the breakdown total', () => {
    const est = estimateNormalCost(gemini, { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(est.basis).toBe('normal');
    expect(est.nanoUsd).toBe(usdToNano(2) + usdToNano(10));
    expect(est.nanoUsd).toBe(est.breakdown.totalNanoUsd);
  });

  it('carries provider/model and surfaces that the price is unverified', () => {
    const est = estimateNormalCost(gemini, EMPTY_USAGE);
    expect(est.provider).toBe('google');
    expect(est.model).toBe('gemini-3.1-pro');
    expect(est.priceVerified).toBe(false); // estimate until SPEC-030 verifies
  });

  it('zero usage costs zero', () => {
    expect(estimateNormalCost(gemini, EMPTY_USAGE).nanoUsd).toBe(0);
  });
});
