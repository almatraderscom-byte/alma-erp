import { describe, it, expect } from 'vitest';
import { costForUsage } from '../usage-cost';
import { EMPTY_USAGE } from '../tokens';
import { getPrice, usdToNano, type ProviderPrice } from '../../providers/pricing/registry';

const gemini = getPrice('google', 'gemini-3.1-pro')!; // in $2 cached $0.5 out $10 reasoning $10 /MTok

describe('costForUsage — reasoning + tool calls', () => {
  it('reuses input/cached/output from cost-calc', () => {
    const b = costForUsage(gemini, { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(b.inputNanoUsd).toBe(usdToNano(2));
    expect(b.outputNanoUsd).toBe(usdToNano(10));
  });

  it('bills reasoning tokens at the reasoning rate', () => {
    const b = costForUsage(gemini, { ...EMPTY_USAGE, reasoningTokens: 1_000_000 });
    expect(b.reasoningNanoUsd).toBe(usdToNano(10));
    expect(b.totalNanoUsd).toBe(usdToNano(10));
  });

  it('falls back to the output rate when no reasoning rate is published', () => {
    const noReason: ProviderPrice = { ...gemini, reasoningNanoUsdPerMTok: undefined };
    const b = costForUsage(noReason, { ...EMPTY_USAGE, reasoningTokens: 1_000_000 });
    expect(b.reasoningNanoUsd).toBe(usdToNano(10)); // output rate
  });

  it('bills per-tool-call charges', () => {
    const withTool: ProviderPrice = { ...gemini, perToolCallNanoUsd: usdToNano(0.001) };
    const b = costForUsage(withTool, { ...EMPTY_USAGE, toolCalls: 5 });
    expect(b.toolCallsNanoUsd).toBe(5 * usdToNano(0.001));
  });

  it('tool calls cost 0 when no per-call price is set', () => {
    const b = costForUsage(gemini, { ...EMPTY_USAGE, toolCalls: 5 });
    expect(b.toolCallsNanoUsd).toBe(0);
  });

  it('totals every component', () => {
    const withTool: ProviderPrice = { ...gemini, perToolCallNanoUsd: usdToNano(0.001) };
    const b = costForUsage(withTool, {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 1_000_000, toolCalls: 2,
    });
    const expected = usdToNano(2) + usdToNano(10) + usdToNano(10) + 2 * usdToNano(0.001);
    expect(b.totalNanoUsd).toBe(expected);
  });
});
