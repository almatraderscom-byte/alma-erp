import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { makeRequest, createFakeCostPort } from './_helpers';
import type { AdapterCall } from '@/agent/providers/runtime/adapter';

// T1 primary binding is openrouter/or-deepseek-v4-flash.
const t1Adapter = (rules?: Parameters<typeof createFakeAdapter>[0]['rules']) =>
  createFakeAdapter({ provider: 'openrouter', models: ['or-deepseek-v4-flash'], rules });

const okJson = (body: string) => [{ match: () => true, outcome: { kind: 'OK' as const, text: body, usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' as const } }];

describe('SPEC-153 classifier/extractor T1 tier', () => {
  it('classify: valid label within the closed set → COMPLETED', async () => {
    const cost = createFakeCostPort();
    const adapter = t1Adapter(okJson('{"label":"order_status"}'));
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'কবে আসবে আমার অর্ডার?', responseFormat: 'json', labels: ['order_status', 'complaint', 'greeting'] }),
      { cost, adapters: [adapter] },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.tier).toBe('T1');
      expect(res.value.provider).toBe('openrouter');
      expect(JSON.parse(res.value.text).label).toBe('order_status');
    }
  });

  it('classify: label outside the closed set → OUTPUT_MALFORMED (fail closed, no guessing)', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'x', responseFormat: 'json', labels: ['a', 'b'] }),
      { cost, adapters: [t1Adapter(okJson('{"label":"c"}'))] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_OUTPUT_MALFORMED');
    expect(cost.settled).toHaveLength(1); // spend still accounted
  });

  it('extract: non-JSON provider output → OUTPUT_MALFORMED', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'extract', prompt: 'invoice text', responseFormat: 'json' }),
      { cost, adapters: [t1Adapter(okJson('not json'))] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_OUTPUT_MALFORMED');
  });

  it('refuses free-form (text) output requests → MALFORMED_INPUT', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'x', responseFormat: 'text' }),
      { cost, adapters: [t1Adapter()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MALFORMED_INPUT');
  });

  it('rejects a reasoning task on the classifier tier → MALFORMED_INPUT', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'reason', prompt: 'x', responseFormat: 'json' }),
      { cost, adapters: [t1Adapter()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
  });

  it('clamps output to the tiny T1 ceiling (512)', async () => {
    const cost = createFakeCostPort();
    let seen: AdapterCall | undefined;
    const adapter = createFakeAdapter({
      provider: 'openrouter',
      models: ['or-deepseek-v4-flash'],
      rules: [{ match: (c) => { seen = c; return true; }, outcome: (c) => ({ kind: 'OK', text: '{"label":"a"}', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, toolCalls: 0 }, finishReason: 'stop' }) }],
    });
    await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'x', responseFormat: 'json', maxOutputTokens: 999999, labels: ['a'] }),
      { cost, adapters: [adapter] },
    );
    expect(seen?.maxOutputTokens).toBe(512);
  });
});
