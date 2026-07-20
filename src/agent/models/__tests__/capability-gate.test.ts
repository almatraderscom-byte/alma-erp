import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { makeRequest, createFakeCostPort } from './_helpers';

describe('SPEC-157 capability gate wired into the fabric', () => {
  it('required capability the chosen model lacks → CAPABILITY_UNSUPPORTED, before cost + provider', async () => {
    const cost = createFakeCostPort();
    // T1 primary = openrouter/or-deepseek-v4-flash, which declares vision:false
    const adapter = createFakeAdapter({ provider: 'openrouter', models: ['or-deepseek-v4-flash'] });
    const res = await invokeModel(
      makeRequest({ tier: 'T1', taskKind: 'classify', prompt: 'x', responseFormat: 'json', labels: ['a'], requiredCapabilities: ['vision'] }),
      { cost, adapters: [adapter] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) {
      expect(res.reasonCodes).toContain('MODEL_CAPABILITY_UNSUPPORTED');
      expect(res.reasonCodes).toContain('CAP:vision');
    }
    // fail closed BEFORE authorization + provider
    expect(cost.authorizeCalls).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it('supported capability passes the gate and proceeds', async () => {
    const cost = createFakeCostPort();
    const adapter = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text', requiredCapabilities: ['json', 'vision', 'reasoning'] }),
      { cost, adapters: [adapter] },
    );
    expect(isSuccess(res)).toBe(true);
  });
});
