import { describe, it, expect } from 'vitest';
import { classifyRisk, riskStage } from '../risk';
import type { NormalizedRequest } from '../normalize';

const nr = (over: Partial<NormalizedRequest>): NormalizedRequest => ({
  channel: 'telegram', text: '', command: null, hasAttachments: false, ...over,
});

describe('classifyRisk', () => {
  it('LOW for read-only / greeting', () => {
    expect(classifyRisk(nr({ text: 'what is the order status?' })).risk).toBe('LOW');
    expect(classifyRisk(nr({ text: 'assalamu alaikum' })).risk).toBe('LOW');
  });

  it('HIGH for money movement (english + bangla)', () => {
    expect(classifyRisk(nr({ text: 'pay the supplier now' })).risk).toBe('HIGH');
    expect(classifyRisk(nr({ text: 'salary transfer koro' })).risk).toBe('HIGH');
    expect(classifyRisk(nr({ text: 'taka pathao' })).risk).toBe('HIGH');
  });

  it('HIGH for destructive actions', () => {
    expect(classifyRisk(nr({ text: 'delete the customer record' })).risk).toBe('HIGH');
  });

  it('MED for non-money side effects', () => {
    expect(classifyRisk(nr({ text: 'post this to facebook' })).risk).toBe('MED');
    expect(classifyRisk(nr({ text: 'send a reminder message' })).risk).toBe('MED');
  });

  it('fail-closed: money context + side effect escalates to HIGH', () => {
    const r = classifyRisk(nr({ text: 'send the invoice for 5000 taka' }));
    expect(r.risk).toBe('HIGH');
    expect(r.reasons).toContain('money-context+side-effect');
  });

  it('money mention alone is at least MED (never LOW)', () => {
    expect(classifyRisk(nr({ text: 'the balance is 2000 taka' })).risk).toBe('MED');
  });

  it('is deterministic', () => {
    const t = 'pay 500';
    expect(classifyRisk(nr({ text: t })).risk).toBe(classifyRisk(nr({ text: t })).risk);
  });
});

describe('riskStage', () => {
  it('annotates risk onto the context', () => {
    const r = riskStage.run({
      identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
      input: { channel: 'telegram' },
      annotations: { normalized: nr({ text: 'pay now' }) },
      evidenceIds: [],
    });
    if (r.ok) expect(r.ctx.annotations.risk).toBe('HIGH');
  });
});
