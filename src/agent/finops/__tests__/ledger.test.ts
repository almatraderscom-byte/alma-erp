import { describe, it, expect } from 'vitest';
import { InMemoryCostLedger, costEventSchema, type CostEvent } from '../ledger';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's1', correlationId: 'c1' };

function ev(over: Partial<CostEvent> = {}): CostEvent {
  return {
    id: 'c1:s1',
    identity,
    provider: 'google',
    model: 'gemini-3.1-pro',
    estimatedNanoUsd: 2_000_000_000,
    actualNanoUsd: null,
    status: 'UNKNOWN',
    priceVerified: false,
    observedAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe('costEventSchema', () => {
  it('accepts a valid event and rejects a bad one', () => {
    expect(costEventSchema.safeParse(ev()).success).toBe(true);
    expect(costEventSchema.safeParse({ ...ev(), estimatedNanoUsd: -1 }).success).toBe(false);
  });
});

describe('InMemoryCostLedger', () => {
  it('records and lists events', () => {
    const l = new InMemoryCostLedger();
    l.record(ev());
    expect(l.all()).toHaveLength(1);
  });

  it('throws on an invalid event (fail-closed)', () => {
    const l = new InMemoryCostLedger();
    expect(() => l.record(ev({ provider: '' }))).toThrow();
  });

  it('queries by tenant / correlation / provider', () => {
    const l = new InMemoryCostLedger();
    l.record(ev({ id: 'a', provider: 'google' }));
    l.record(ev({ id: 'b', provider: 'openrouter' }));
    expect(l.query({ provider: 'google' })).toHaveLength(1);
    expect(l.query({ tenantId: 'alma' })).toHaveLength(2);
    expect(l.query({ tenantId: 'other' })).toHaveLength(0);
  });

  it('totals actual where known, else estimated', () => {
    const l = new InMemoryCostLedger();
    l.record(ev({ id: 'a', actualNanoUsd: 1_000_000_000, status: 'UNDER' })); // actual $1
    l.record(ev({ id: 'b', actualNanoUsd: null, estimatedNanoUsd: 3_000_000_000 })); // est $3
    expect(l.totalNanoUsd()).toBe(1_000_000_000 + 3_000_000_000);
  });

  it('all() returns a copy (append-only, no external mutation)', () => {
    const l = new InMemoryCostLedger();
    l.record(ev());
    l.all().pop();
    expect(l.all()).toHaveLength(1);
  });
});
