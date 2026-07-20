import { describe, it, expect } from 'vitest';
import { runAdapterConformance, validateOutcome, standardSampleCalls } from '../conformance';
import { createFakeAdapter } from '../fake-adapter';
import type { AdapterCall, AdapterOutcome, ProviderAdapter } from '../adapter';

// Every model the fabric's default registry can route to.
const ROUTABLE: Array<{ provider: string; model: string }> = [
  { provider: 'google', model: 'gemini-3.1-pro' },
  { provider: 'openrouter', model: 'or-deepseek-v4-flash' },
  { provider: 'openrouter', model: 'or-qwen3-max' },
  { provider: 'anthropic', model: 'claude-opus-4-8' },
];

describe('SPEC-160 adapter conformance — FAKE adapters pass', () => {
  for (const { provider, model } of ROUTABLE) {
    it(`${provider}/${model} passes the conformance battery`, async () => {
      const adapter = createFakeAdapter({ provider, models: [model] });
      const report = await runAdapterConformance(adapter, { model });
      expect(report.passed, JSON.stringify(report.checks.filter((c) => !c.ok))).toBe(true);
      // battery actually ran (supports + per-call invoke/outcome/determinism)
      expect(report.checks.length).toBeGreaterThanOrEqual(1 + standardSampleCalls(model, provider).length * 3);
    });
  }
});

describe('SPEC-160 conformance — harness catches real violations (negative)', () => {
  it('fails when the adapter overshoots maxOutputTokens', async () => {
    const bad = createFakeAdapter({
      provider: 'x',
      rules: [{ match: () => true, outcome: { kind: 'OK', text: 'y', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 10_000, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' } }],
    });
    const report = await runAdapterConformance(bad, { model: 'm' });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.name.startsWith('outcome-valid') && !c.ok && /exceeds maxOutputTokens/.test(c.detail ?? ''))).toBe(true);
  });

  it('fails when json format yields non-JSON text', async () => {
    const bad = createFakeAdapter({
      provider: 'x',
      rules: [{ match: (c) => c.responseFormat === 'json', outcome: { kind: 'OK', text: 'not json', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' } }],
    });
    const report = await runAdapterConformance(bad, { model: 'm' });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.name === 'outcome-valid:json' && !c.ok)).toBe(true);
  });

  it('fails when the adapter is non-deterministic', async () => {
    let n = 0;
    const flaky: ProviderAdapter = {
      provider: 'x',
      supports: () => true,
      async invoke(call: AdapterCall): Promise<AdapterOutcome> {
        n += 1;
        return { kind: 'OK', text: `v${n}`, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' };
      },
    };
    const report = await runAdapterConformance(flaky, { model: 'm' });
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.name.startsWith('deterministic') && !c.ok)).toBe(true);
  });

  it('fails when supports() is false for the model under test', async () => {
    const adapter = createFakeAdapter({ provider: 'x', models: ['other'] });
    const report = await runAdapterConformance(adapter, { model: 'm' });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === 'supports-model')?.ok).toBe(false);
  });

  it('validateOutcome flags a RETRYABLE without providerCode', () => {
    const call = standardSampleCalls('m', 'x')[0];
    const issues = validateOutcome({ kind: 'RETRYABLE', providerCode: '' } as AdapterOutcome, call);
    expect(issues.some((i) => /providerCode/.test(i))).toBe(true);
  });
});
