import { describe, it, expect } from 'vitest';
import { EMPTY_USAGE } from '@/agent/finops/tokens';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { makeRequest, createFakeCostPort, stubTierHandler } from './_helpers';

const googleAdapter = () => createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
const handlers = { T3: stubTierHandler('T3') };

describe('SPEC-151 fabric — happy path', () => {
  it('validates → authorizes → invokes → settles → COMPLETED', async () => {
    const cost = createFakeCostPort();
    const adapter = googleAdapter();
    const res = await invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'Boss, status?', responseFormat: 'text' }), {
      cost,
      adapters: [adapter],
      handlers,
    });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.provider).toBe('google');
      expect(res.value.model).toBe('gemini-3.1-pro');
      expect(res.value.deterministic).toBe(false);
      expect(res.value.attempts).toBe(1);
      expect(res.value.authorizationId).toBe('auth-1');
    }
    expect(cost.authorizeCalls).toHaveLength(1);
    expect(cost.settled).toHaveLength(1); // real spend accounted
    expect(cost.released).toHaveLength(0);
    expect(adapter.calls).toHaveLength(1);
    // model receives a bounded view, not identity internals
    expect(adapter.calls[0].prompt).toBe('Boss, status?');
  });
});

describe('SPEC-151 fabric — identity / contract failures (fail closed)', () => {
  it('missing tenant → FAILED_FINAL MISSING_TENANT, no provider call', async () => {
    const cost = createFakeCostPort();
    const adapter = googleAdapter();
    const res = await invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }, { tenantId: '' }), {
      cost,
      adapters: [adapter],
      handlers,
    });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MISSING_TENANT');
    expect(adapter.calls).toHaveLength(0);
    expect(cost.authorizeCalls).toHaveLength(0);
  });

  it('contract version mismatch → FAILED_FINAL', async () => {
    const cost = createFakeCostPort();
    const req = { ...makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }), contractVersion: '9.9.9' };
    const res = await invokeModel(req, { cost, adapters: [googleAdapter()], handlers });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('CONTRACT_VERSION_MISMATCH');
  });

  it('tier without a handler → FAILED_FINAL TIER_NOT_IMPLEMENTED', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(makeRequest({ tier: 'T2', taskKind: 'specialist', prompt: 'x', responseFormat: 'text' }), {
      cost,
      adapters: [googleAdapter()],
      handlers, // only T3 registered
    });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_TIER_NOT_IMPLEMENTED');
  });

  it('oversized input → FAILED_FINAL INPUT_OVERSIZED', async () => {
    const cost = createFakeCostPort();
    const huge = 'a'.repeat(200_000 * 4 + 1); // beyond T3 maxInputTokens*4
    const res = await invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: huge, responseFormat: 'text' }), {
      cost,
      adapters: [googleAdapter()],
      handlers,
    });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_INPUT_OVERSIZED');
  });
});

describe('SPEC-151 fabric — cost governance (INV-03, fail closed)', () => {
  it('adapter missing → FAILED_FINAL, no authorize', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }), {
      cost,
      adapters: [], // no adapter registered
      handlers,
    });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_ADAPTER_MISSING');
    expect(cost.authorizeCalls).toHaveLength(0);
  });

  it('budget denial → BUDGET_EXCEEDED, provider never called', async () => {
    const cost = createFakeCostPort({ deny: 'BUDGET_EXCEEDED', reasonCodes: ['BUDGET_EXCEEDED'] });
    const adapter = googleAdapter();
    const res = await invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }), {
      cost,
      adapters: [adapter],
      handlers,
    });
    expect(res.status).toBe('BUDGET_EXCEEDED');
    expect(adapter.calls).toHaveLength(0);
    expect(cost.settled).toHaveLength(0);
  });
});

describe('SPEC-151 fabric — provider outcome mapping', () => {
  const run = (rule: Parameters<typeof createFakeAdapter>[0]['rules']) => {
    const cost = createFakeCostPort();
    const adapter = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'], rules: rule });
    return invokeModel(makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }), { cost, adapters: [adapter], handlers }).then((res) => ({ res, cost }));
  };

  it('TIMEOUT → RETRYABLE + reservation released', async () => {
    const { res, cost } = await run([{ match: () => true, outcome: { kind: 'TIMEOUT' } }]);
    expect(res.status).toBe('RETRYABLE');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_PROVIDER_TIMEOUT');
    expect(cost.released).toEqual(['auth-1']);
    expect(cost.settled).toHaveLength(0);
  });

  it('FINAL → FAILED_FINAL + released', async () => {
    const { res, cost } = await run([{ match: () => true, outcome: { kind: 'FINAL', providerCode: '400' } }]);
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_PROVIDER_FINAL');
    expect(cost.released).toEqual(['auth-1']);
  });

  it('UNKNOWN → UNKNOWN_OUTCOME (reconciliation, never blind retry)', async () => {
    const { res } = await run([{ match: () => true, outcome: { kind: 'UNKNOWN' } }]);
    expect(res.status).toBe('UNKNOWN_OUTCOME');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('UNKNOWN_OUTCOME');
  });

  it('output beyond tier ceiling → OUTPUT_OVERSIZED but spend accounted', async () => {
    const { res, cost } = await run([
      { match: () => true, outcome: { kind: 'OK', text: 'x', usage: { ...EMPTY_USAGE, inputTokens: 1, outputTokens: 999_999 }, finishReason: 'stop' } },
    ]);
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_OUTPUT_OVERSIZED');
    expect(cost.settled).toHaveLength(1); // real tokens still settled
    expect(cost.released).toHaveLength(0);
  });
});
