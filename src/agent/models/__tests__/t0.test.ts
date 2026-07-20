import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { createT0Handler, DEFAULT_T0_TEMPLATES } from '../t0';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { makeRequest, createFakeCostPort } from './_helpers';

// A T0 request must resolve WITHOUT touching the adapter or the cost port.
const spyAdapter = () => createFakeAdapter({ provider: 'google' });

describe('SPEC-152 deterministic T0 path', () => {
  it('resolves a registered template with NO provider call and NO cost authorization', async () => {
    const cost = createFakeCostPort();
    const adapter = spyAdapter();
    const res = await invokeModel(
      makeRequest({ tier: 'T0', taskKind: 'deterministic', prompt: '', responseFormat: 'text', deterministicKey: 'echo', deterministicVars: { text: 'PONG' } }),
      { cost, adapters: [adapter] }, // default handlers include T0
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.text).toBe('PONG');
      expect(res.value.deterministic).toBe(true);
      expect(res.value.tier).toBe('T0');
      expect(res.value.attempts).toBe(0);
      expect(res.value.usage.inputTokens).toBe(0);
      expect(res.value.usage.outputTokens).toBe(0);
    }
    // INV-01: no LLM call, no cost authorization for deterministic work
    expect(adapter.calls).toHaveLength(0);
    expect(cost.authorizeCalls).toHaveLength(0);
    expect(cost.settled).toHaveLength(0);
  });

  it('is a pure function — same input renders identical output', () => {
    const h = createT0Handler();
    const p1 = h.prepare({ tier: 'T0', taskKind: 'deterministic', prompt: '', responseFormat: 'text', deterministicKey: 'kv', deterministicVars: { b: '2', a: '1' } } as never, {} as never, {} as never);
    const p2 = h.prepare({ tier: 'T0', taskKind: 'deterministic', prompt: '', responseFormat: 'text', deterministicKey: 'kv', deterministicVars: { b: '2', a: '1' } } as never, {} as never, {} as never);
    expect(p1).toEqual(p2);
    if (p1.kind === 'RESOLVED') expect(p1.value.text).toBe('a=1\nb=2'); // stable key order
  });

  it('unknown template key fails closed — never escalates to an LLM tier', async () => {
    const cost = createFakeCostPort();
    const adapter = spyAdapter();
    const res = await invokeModel(
      makeRequest({ tier: 'T0', taskKind: 'deterministic', prompt: '', responseFormat: 'text', deterministicKey: 'does-not-exist' }),
      { cost, adapters: [adapter] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_T0_TEMPLATE_UNKNOWN');
    expect(adapter.calls).toHaveLength(0);
    expect(cost.authorizeCalls).toHaveLength(0);
  });

  it('missing deterministicKey → MODEL_NOT_CONFIGURED', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T0', taskKind: 'deterministic', prompt: '', responseFormat: 'text' }),
      { cost, adapters: [spyAdapter()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_NOT_CONFIGURED');
  });

  it('wrong taskKind for T0 → MALFORMED_INPUT', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T0', taskKind: 'reason', prompt: '', responseFormat: 'text', deterministicKey: 'ack' }),
      { cost, adapters: [spyAdapter()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MALFORMED_INPUT');
  });

  it('built-in ack template addresses the owner as Boss (never Sir)', () => {
    const out = DEFAULT_T0_TEMPLATES.ack.render({});
    expect(out).toContain('Boss');
    expect(out).not.toMatch(/Sir|স্যার/);
  });
});
