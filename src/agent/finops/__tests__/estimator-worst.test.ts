import { describe, it, expect } from 'vitest';
import { estimateNormalCost, estimateWorstCaseCost } from '../estimator';
import { EMPTY_USAGE } from '../tokens';
import { getPrice, usdToNano } from '../../providers/pricing/registry';

const gemini = getPrice('google', 'gemini-3.1-pro')!;

describe('estimateWorstCaseCost (SPEC-026)', () => {
  it('assumes no cache benefit (all input at full rate)', () => {
    const est = estimateWorstCaseCost(gemini, { maxInputTokens: 1_000_000, maxOutputTokens: 0 });
    expect(est.basis).toBe('worst_case');
    expect(est.breakdown.cachedInputNanoUsd).toBe(0);
    expect(est.breakdown.inputNanoUsd).toBe(usdToNano(2));
  });

  it('is never cheaper than the normal estimate for the same tokens', () => {
    const tokens = { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 };
    const worst = estimateWorstCaseCost(gemini, tokens);
    // normal case where half the input was cached -> cheaper
    const normal = estimateNormalCost(gemini, {
      ...EMPTY_USAGE, inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 1_000_000,
    });
    expect(worst.nanoUsd).toBeGreaterThan(normal.nanoUsd);
  });

  it('includes max reasoning + tool budget', () => {
    const withTool = { ...gemini, perToolCallNanoUsd: usdToNano(0.01) };
    const est = estimateWorstCaseCost(withTool, {
      maxInputTokens: 0, maxOutputTokens: 0, maxReasoningTokens: 1_000_000, maxToolCalls: 3,
    });
    expect(est.breakdown.reasoningNanoUsd).toBe(usdToNano(10));
    expect(est.breakdown.toolCallsNanoUsd).toBe(3 * usdToNano(0.01));
  });

  it('clamps negative bounds to zero', () => {
    const est = estimateWorstCaseCost(gemini, { maxInputTokens: -100, maxOutputTokens: -1 });
    expect(est.nanoUsd).toBe(0);
  });
});
