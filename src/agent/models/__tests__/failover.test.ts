import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFailoverAttemptRunner } from '../attempt-runner';
import { createQuotaController } from '@/agent/providers/runtime/timeout-quota';
import { shouldFailover } from '@/agent/providers/runtime/failover';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { fixedClock } from '../ports';
import { makeRequest, createFakeCostPort } from './_helpers';

// T3 candidates (in order): google/gemini-3.1-pro (primary), openrouter/or-qwen3-max (failover).
const t3 = () => makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' });
const runner = () => createFailoverAttemptRunner({ clock: fixedClock(0) });
const timeoutRule = [{ match: () => true, outcome: { kind: 'TIMEOUT' as const } }];
const finalRule = [{ match: () => true, outcome: { kind: 'FINAL' as const, providerCode: '400' } }];

describe('SPEC-159 failover policy', () => {
  it('shouldFailover: transient yes, permanent/unknown/ok no', () => {
    expect(shouldFailover({ kind: 'TIMEOUT' })).toBe(true);
    expect(shouldFailover({ kind: 'RETRYABLE', providerCode: '503' })).toBe(true);
    expect(shouldFailover({ kind: 'FINAL', providerCode: '400' })).toBe(false);
    expect(shouldFailover({ kind: 'UNKNOWN' })).toBe(false);
  });
});

describe('SPEC-159 in-tier failover through the fabric', () => {
  it('primary transient failure → next candidate serves it (stays in tier)', async () => {
    const cost = createFakeCostPort();
    const primary = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'], rules: timeoutRule });
    const backup = createFakeAdapter({ provider: 'openrouter', models: ['or-qwen3-max'] });
    const res = await invokeModel(t3(), { cost, adapters: [primary, backup], attemptRunner: runner() });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.model).toBe('or-qwen3-max'); // failed over
      expect(res.value.tier).toBe('T3'); // NEVER escalated to a costlier tier
      expect(res.value.attempts).toBe(2);
    }
    expect(cost.settled).toHaveLength(1); // single authorization settled
  });

  it('permanent FINAL on the primary → no failover, secondary never called', async () => {
    const cost = createFakeCostPort();
    const primary = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'], rules: finalRule });
    const backup = createFakeAdapter({ provider: 'openrouter', models: ['or-qwen3-max'] });
    const res = await invokeModel(t3(), { cost, adapters: [primary, backup], attemptRunner: runner() });
    expect(res.status).toBe('FAILED_FINAL');
    expect(backup.calls).toHaveLength(0); // did not waste money on the same bad request
    expect(cost.released).toHaveLength(1);
  });

  it('all candidates transient-fail → ALL_PROVIDERS_FAILED (RETRYABLE)', async () => {
    const cost = createFakeCostPort();
    const primary = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'], rules: timeoutRule });
    const backup = createFakeAdapter({ provider: 'openrouter', models: ['or-qwen3-max'], rules: timeoutRule });
    const res = await invokeModel(t3(), { cost, adapters: [primary, backup], attemptRunner: runner() });
    expect(res.status).toBe('RETRYABLE');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_ALL_PROVIDERS_FAILED');
    expect(cost.released).toHaveLength(1);
  });

  it('primary rate-limited → failover to next provider (quota is per provider)', async () => {
    const cost = createFakeCostPort();
    const quota = createQuotaController({ limitPerWindow: 0, windowMs: 1000 }); // google denied immediately... but 0 denies all
    // use a controller that denies google but allows openrouter: pre-consume google
    const q2 = createQuotaController({ limitPerWindow: 1, windowMs: 1000 });
    q2.tryAcquire('google', 0); // exhaust google's single slot
    const failRunner = createFailoverAttemptRunner({ clock: fixedClock(0), quota: q2 });
    const primary = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
    const backup = createFakeAdapter({ provider: 'openrouter', models: ['or-qwen3-max'] });
    const res = await invokeModel(t3(), { cost, adapters: [primary, backup], attemptRunner: failRunner });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) expect(res.value.model).toBe('or-qwen3-max');
    expect(primary.calls).toHaveLength(0); // google was quota-blocked, never called
    void quota;
  });
});
