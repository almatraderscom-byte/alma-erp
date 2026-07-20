import { describe, it, expect } from 'vitest';
import { costForTokens, perMTokCost } from '../cost-calc';
import { getPrice, usdToNano } from '../../providers/pricing/registry';

const gemini = getPrice('google', 'gemini-3.1-pro')!; // input $2, cached $0.5, output $10 /MTok

describe('perMTokCost', () => {
  it('computes integer nano-USD per million tokens', () => {
    // 1,000,000 tokens at $2/MTok = $2 = 2e9 nano
    expect(perMTokCost(1_000_000, usdToNano(2))).toBe(usdToNano(2));
    // 500,000 tokens at $2/MTok = $1
    expect(perMTokCost(500_000, usdToNano(2))).toBe(usdToNano(1));
  });
  it('returns 0 for zero/negative tokens or missing rate', () => {
    expect(perMTokCost(0, usdToNano(2))).toBe(0);
    expect(perMTokCost(-5, usdToNano(2))).toBe(0);
    expect(perMTokCost(1000, undefined)).toBe(0);
  });
});

describe('costForTokens — cached input', () => {
  it('bills all input at input rate when nothing is cached', () => {
    const b = costForTokens(gemini, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(b.inputNanoUsd).toBe(usdToNano(2));
    expect(b.cachedInputNanoUsd).toBe(0);
  });

  it('bills cached portion at the cheaper cached rate', () => {
    // 1M input, 1M cached -> all at cached $0.5
    const b = costForTokens(gemini, { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
    expect(b.inputNanoUsd).toBe(0);
    expect(b.cachedInputNanoUsd).toBe(usdToNano(0.5));
  });

  it('splits input: half cached, half full-rate', () => {
    const b = costForTokens(gemini, { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 });
    expect(b.inputNanoUsd).toBe(usdToNano(1)); // 500k @ $2
    expect(b.cachedInputNanoUsd).toBe(usdToNano(0.25)); // 500k @ $0.5
  });

  it('adds output cost and totals correctly', () => {
    const b = costForTokens(gemini, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(b.outputNanoUsd).toBe(usdToNano(10));
    expect(b.totalNanoUsd).toBe(usdToNano(2) + usdToNano(10));
  });

  it('clamps cached tokens to input tokens (cannot exceed)', () => {
    const b = costForTokens(gemini, { inputTokens: 100, cachedInputTokens: 999_999, outputTokens: 0 });
    // all 100 treated as cached, 0 billable input
    expect(b.inputNanoUsd).toBe(0);
  });

  it('returns zero for a non per_mtok price (media priced elsewhere)', () => {
    const whisper = getPrice('openai', 'whisper-1')!;
    expect(costForTokens(whisper, { inputTokens: 1000, outputTokens: 0 }).totalNanoUsd).toBe(0);
  });
});
