import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { createT4Handler, createInMemoryDailyCap, type FrontierApprovalVerifier } from '../t4';
import { fixedClock } from '../ports';
import { makeRequest, createFakeCostPort } from './_helpers';

const opus = () => createFakeAdapter({ provider: 'anthropic', models: ['claude-opus-4-8'] });
const acceptToken = (t: string): FrontierApprovalVerifier => ({ verify: (token) => token === t });

describe('SPEC-156 frontier escalation T4 tier — fail closed by default', () => {
  it('default handler rejects with NEEDS_APPROVAL (no approval authority wired)', async () => {
    const cost = createFakeCostPort();
    const adapter = opus();
    const res = await invokeModel(
      makeRequest({ tier: 'T4', taskKind: 'frontier', prompt: 'big decision', responseFormat: 'text', approvalToken: 'whatever' }),
      { cost, adapters: [adapter] }, // default handlers → reject-all
    );
    expect(res.status).toBe('NEEDS_APPROVAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('MODEL_FRONTIER_APPROVAL_REQUIRED');
    expect(adapter.calls).toHaveLength(0); // never escalates without approval
  });

  it('missing approval token → NEEDS_APPROVAL, provider never called', async () => {
    const cost = createFakeCostPort();
    const handlers = { T4: createT4Handler({ approvals: acceptToken('ok'), dailyCap: createInMemoryDailyCap(5) }) };
    const adapter = opus();
    const res = await invokeModel(
      makeRequest({ tier: 'T4', taskKind: 'frontier', prompt: 'x', responseFormat: 'text' }),
      { cost, adapters: [adapter], handlers },
    );
    expect(res.status).toBe('NEEDS_APPROVAL');
    expect(adapter.calls).toHaveLength(0);
    expect(cost.authorizeCalls).toHaveLength(0);
  });
});

describe('SPEC-156 frontier escalation T4 tier — approved path', () => {
  const handlers = () => ({ T4: createT4Handler({ approvals: acceptToken('golden'), dailyCap: createInMemoryDailyCap(2) }) });

  it('valid approval → COMPLETED on the frontier model', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T4', taskKind: 'frontier', prompt: 'big money call', responseFormat: 'text', approvalToken: 'golden' }),
      { cost, adapters: [opus()], handlers: handlers(), clock: fixedClock(0) },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.tier).toBe('T4');
      expect(res.value.model).toBe('claude-opus-4-8');
    }
  });

  it('daily cap is enforced per actor per day', async () => {
    const cost = createFakeCostPort();
    const h = handlers(); // cap = 2
    const clock = fixedClock(0);
    const req = () => invokeModel(
      makeRequest({ tier: 'T4', taskKind: 'frontier', prompt: 'x', responseFormat: 'text', approvalToken: 'golden' }),
      { cost, adapters: [opus()], handlers: h, clock },
    );
    expect((await req()).status).toBe('COMPLETED');
    expect((await req()).status).toBe('COMPLETED');
    const third = await req();
    expect(third.status).toBe('DENIED');
    if (!isSuccess(third)) expect(third.reasonCodes).toContain('MODEL_FRONTIER_DAILY_CAP_EXCEEDED');
  });

  it('cap resets on a new day (clock-driven, deterministic)', async () => {
    const cost = createFakeCostPort();
    const h = { T4: createT4Handler({ approvals: acceptToken('golden'), dailyCap: createInMemoryDailyCap(1) }) };
    const clock = fixedClock(0);
    const call = () => invokeModel(
      makeRequest({ tier: 'T4', taskKind: 'frontier', prompt: 'x', responseFormat: 'text', approvalToken: 'golden' }),
      { cost, adapters: [opus()], handlers: h, clock },
    );
    expect((await call()).status).toBe('COMPLETED');
    expect((await call()).status).toBe('DENIED'); // cap 1 hit same day
    clock.advance(86_400_000); // +1 day
    expect((await call()).status).toBe('COMPLETED'); // reset
  });

  it('never auto-escalates: a T3 request stays on T3 even with an approval token', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text', approvalToken: 'golden' }),
      { cost, adapters: [createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] })] },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) expect(res.value.tier).toBe('T3'); // no silent promotion to T4
  });
});
