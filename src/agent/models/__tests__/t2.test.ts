import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { T2_ROLES } from '../t2';
import { makeRequest, createFakeCostPort } from './_helpers';

// T2 has two bindings: ops→openrouter/or-deepseek-v4-flash, cs→openrouter/or-qwen3-max.
const deepseek = () => createFakeAdapter({ provider: 'openrouter', models: ['or-deepseek-v4-flash', 'or-qwen3-max'] });

describe('SPEC-154 cheap specialist T2 tier', () => {
  it('ops role routes to the cheap model', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'dispatch staff', responseFormat: 'text', role: 'ops' }),
      { cost, adapters: [deepseek()] },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.model).toBe('or-deepseek-v4-flash');
      expect(res.value.tier).toBe('T2');
    }
  });

  it('cs (customer-facing) role routes to the stronger Bangla model', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'গ্রাহক প্রশ্ন', responseFormat: 'text', role: 'cs' }),
      { cost, adapters: [deepseek()] },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) expect(res.value.model).toBe('or-qwen3-max');
  });

  it('missing / unknown role → MALFORMED_INPUT (specialist tier needs a known role)', async () => {
    const cost = createFakeCostPort();
    const noRole = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'x', responseFormat: 'text' }),
      { cost, adapters: [deepseek()] },
    );
    expect(noRole.status).toBe('FAILED_FINAL');
    const badRole = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'x', responseFormat: 'text', role: 'ceo' }),
      { cost, adapters: [deepseek()] },
    );
    expect(badRole.status).toBe('FAILED_FINAL');
  });

  it('wrong taskKind on T2 → FAILED_FINAL', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'reason', prompt: 'x', responseFormat: 'text', role: 'ops' }),
      { cost, adapters: [deepseek()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
  });

  it('json output is validated', async () => {
    const cost = createFakeCostPort();
    const bad = createFakeAdapter({
      provider: 'openrouter',
      models: ['or-deepseek-v4-flash'],
      rules: [{ match: () => true, outcome: { kind: 'OK', text: 'oops', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' } }],
    });
    const res = await invokeModel(
      makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'x', responseFormat: 'json', role: 'orders' }),
      { cost, adapters: [bad] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_OUTPUT_MALFORMED');
  });

  it('exposes the closed role set', () => {
    expect([...T2_ROLES]).toEqual(['ops', 'orders', 'cs', 'marketing', 'research']);
  });
});
