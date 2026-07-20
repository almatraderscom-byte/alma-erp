import { describe, it, expect } from 'vitest';
import { invokeWithTimeout, createQuotaController } from '../timeout-quota';
import { createFakeAdapter } from '../fake-adapter';
import type { AdapterCall } from '../adapter';

const call = (timeoutMs: number): AdapterCall => ({
  provider: 'google', model: 'gemini-3.1-pro', prompt: 'x', responseFormat: 'text', maxOutputTokens: 10, timeoutMs, correlationId: 'c',
});

describe('SPEC-158 timeout classification (deterministic clock)', () => {
  it('elapsed within budget → original outcome preserved', async () => {
    const adapter = createFakeAdapter({ provider: 'google' });
    let t = 0;
    const out = await invokeWithTimeout(adapter, call(1000), () => (t += 10)); // start 10, end 20 → elapsed 10
    expect(out.kind).toBe('OK');
  });

  it('elapsed beyond budget → reclassified as TIMEOUT', async () => {
    const adapter = createFakeAdapter({ provider: 'google' });
    const ticks = [0, 5000]; // start 0, end 5000 → elapsed 5000 > 1000
    let i = 0;
    const out = await invokeWithTimeout(adapter, call(1000), () => ticks[i++]);
    expect(out.kind).toBe('TIMEOUT');
  });
});

describe('SPEC-158 per-provider quota (fixed window)', () => {
  it('admits up to the limit, then denies with precise retryAfterMs', () => {
    const q = createQuotaController({ limitPerWindow: 2, windowMs: 1000 });
    expect(q.tryAcquire('google', 0)).toEqual({ ok: true });
    expect(q.tryAcquire('google', 100)).toEqual({ ok: true });
    expect(q.tryAcquire('google', 200)).toEqual({ ok: false, retryAfterMs: 800 }); // window ends at 1000
  });

  it('window resets after windowMs', () => {
    const q = createQuotaController({ limitPerWindow: 1, windowMs: 1000 });
    expect(q.tryAcquire('google', 0).ok).toBe(true);
    expect(q.tryAcquire('google', 500).ok).toBe(false);
    expect(q.tryAcquire('google', 1000).ok).toBe(true); // new window
  });

  it('quotas are independent per provider', () => {
    const q = createQuotaController({ limitPerWindow: 1, windowMs: 1000 });
    expect(q.tryAcquire('google', 0).ok).toBe(true);
    expect(q.tryAcquire('openrouter', 0).ok).toBe(true);
    expect(q.tryAcquire('google', 0).ok).toBe(false);
  });
});
