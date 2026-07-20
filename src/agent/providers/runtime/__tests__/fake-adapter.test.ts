import { describe, it, expect } from 'vitest';
import { createFakeAdapter, fakeBody, fakeOk } from '../fake-adapter';
import type { AdapterCall } from '../adapter';

const call = (over: Partial<AdapterCall> = {}): AdapterCall => ({
  provider: 'google',
  model: 'gemini-3.1-pro',
  prompt: 'hello world',
  responseFormat: 'text',
  maxOutputTokens: 100,
  timeoutMs: 1000,
  correlationId: 'c1',
  ...over,
});

describe('SPEC-151 fake adapter — determinism & no I/O', () => {
  it('same call → identical body (pure function, no randomness)', () => {
    expect(fakeBody(call())).toBe(fakeBody(call()));
  });

  it('json modality returns parseable JSON', () => {
    const body = fakeBody(call({ responseFormat: 'json' }));
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body).model).toBe('gemini-3.1-pro');
  });

  it('supports() honours the model allow-list', () => {
    const a = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
    expect(a.supports('gemini-3.1-pro')).toBe(true);
    expect(a.supports('claude-opus-4-8')).toBe(false);
    const any = createFakeAdapter({ provider: 'x' });
    expect(any.supports('anything')).toBe(true);
  });

  it('default invoke returns OK with usage derived from prompt', async () => {
    const a = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });
    const out = await a.invoke(call());
    expect(out.kind).toBe('OK');
    if (out.kind === 'OK') {
      expect(out.usage.inputTokens).toBeGreaterThan(0);
      expect(out.usage.outputTokens).toBeGreaterThan(0);
    }
    expect(a.calls).toHaveLength(1);
  });

  it('output clamps to maxOutputTokens and reports finishReason=length', () => {
    const out = fakeOk(call({ maxOutputTokens: 1 }));
    expect(out.kind).toBe('OK');
    if (out.kind === 'OK') {
      expect(out.usage.outputTokens).toBeLessThanOrEqual(1);
      expect(out.finishReason).toBe('length');
    }
  });

  it('rules force outcomes deterministically (first match wins)', async () => {
    const a = createFakeAdapter({
      provider: 'google',
      rules: [
        { match: (c) => c.model === 'boom', outcome: { kind: 'FINAL', providerCode: '400' } },
        { match: () => true, outcome: { kind: 'TIMEOUT' } },
      ],
    });
    expect((await a.invoke(call({ model: 'boom' }))).kind).toBe('FINAL');
    expect((await a.invoke(call({ model: 'ok' }))).kind).toBe('TIMEOUT');
  });
});
