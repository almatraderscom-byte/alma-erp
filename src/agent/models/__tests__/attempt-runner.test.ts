import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createGuardedAttemptRunner } from '../attempt-runner';
import { createQuotaController } from '@/agent/providers/runtime/timeout-quota';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { fixedClock } from '../ports';
import { makeRequest, createFakeCostPort } from './_helpers';

const gemini = () => createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
const t3 = () => makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' });

describe('SPEC-158 timeout/quota wired through the fabric attempt runner', () => {
  it('within timeout and quota → COMPLETED', async () => {
    const cost = createFakeCostPort();
    const runner = createGuardedAttemptRunner({ clock: fixedClock(0), quota: createQuotaController({ limitPerWindow: 5, windowMs: 1000 }) });
    const res = await invokeModel(t3(), { cost, adapters: [gemini()], attemptRunner: runner });
    expect(isSuccess(res)).toBe(true);
  });

  it('quota exhausted → PROVIDER_QUOTA_EXCEEDED, provider not called, reservation released', async () => {
    const cost = createFakeCostPort();
    const quota = createQuotaController({ limitPerWindow: 1, windowMs: 1000 });
    const runner = createGuardedAttemptRunner({ clock: fixedClock(0), quota });
    const adapter = gemini();
    const deps = { cost, adapters: [adapter], attemptRunner: runner };
    // first consumes the single slot
    expect((await invokeModel(t3(), deps)).status).toBe('COMPLETED');
    const denied = await invokeModel(t3(), deps);
    expect(denied.status).toBe('RETRYABLE');
    if (!isSuccess(denied)) expect(denied.reasonCodes).toContain('MODEL_PROVIDER_QUOTA_EXCEEDED');
    expect(adapter.calls).toHaveLength(1); // only the first call reached the provider
    expect(cost.released).toContain('auth-2'); // second reservation released
  });

  it('timeout classification → RETRYABLE PROVIDER_TIMEOUT, reservation released', async () => {
    const cost = createFakeCostPort();
    // clock advances 5000ms across the call; T3 timeout budget is 60000 by default,
    // so force a short budget via maxOutputTokens? Instead use a clock that jumps.
    const clock = fixedClock(0);
    let calls = 0;
    const jumpClock = { now: () => (calls++ === 0 ? 0 : 10_000_000) }; // huge elapsed
    const runner = createGuardedAttemptRunner({ clock: jumpClock });
    const adapter = gemini();
    const res = await invokeModel(t3(), { cost, adapters: [adapter], attemptRunner: runner });
    expect(res.status).toBe('RETRYABLE');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_PROVIDER_TIMEOUT');
    expect(cost.released).toHaveLength(1);
    void clock;
  });
});
