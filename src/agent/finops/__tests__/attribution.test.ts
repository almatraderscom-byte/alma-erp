import { describe, it, expect } from 'vitest';
import { ATTRIBUTION_DIMENSIONS, attributeAll, attributeBy, eventAmount } from '../attribution';
import type { CostEvent } from '../ledger';

function ev(over: Partial<CostEvent> & { id: string }): CostEvent {
  return {
    identity: { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c', ...(over.identity ?? {}) },
    provider: 'google', model: 'gemini-3.1-pro',
    estimatedNanoUsd: 1_000_000_000, actualNanoUsd: null, status: 'UNKNOWN', priceVerified: false, observedAtMs: 1,
    ...over,
  } as CostEvent;
}

const events: CostEvent[] = [
  ev({ id: '1', provider: 'google', actualNanoUsd: 2_000_000_000, status: 'UNDER' }),
  ev({ id: '2', provider: 'openrouter', model: 'or-deepseek-v4-flash', estimatedNanoUsd: 500_000_000 }),
  ev({ id: '3', provider: 'google', identity: { tenantId: 'alma', businessId: 'trading', actorId: 'x', workflowId: 'w2', stepId: 's', correlationId: 'c2' }, actualNanoUsd: 1_000_000_000, status: 'OVER' }),
];

describe('eventAmount', () => {
  it('uses actual where known, else estimated', () => {
    expect(eventAmount(events[0])).toBe(2_000_000_000);
    expect(eventAmount(events[1])).toBe(500_000_000); // estimated (actual null)
  });
});

describe('attributeBy', () => {
  it('groups by provider and sorts by spend desc', () => {
    const rows = attributeBy(events, 'provider');
    expect(rows[0].key).toBe('google');
    expect(rows[0].nanoUsd).toBe(2_000_000_000 + 1_000_000_000);
    expect(rows[0].count).toBe(2);
    expect(rows.find((r) => r.key === 'openrouter')?.nanoUsd).toBe(500_000_000);
  });

  it('groups by model', () => {
    const rows = attributeBy(events, 'model');
    expect(rows.some((r) => r.key === 'or-deepseek-v4-flash')).toBe(true);
  });

  it('uses (none) for a missing optional dimension like businessId', () => {
    const rows = attributeBy(events, 'businessId');
    expect(rows.some((r) => r.key === '(none)')).toBe(true);
    expect(rows.some((r) => r.key === 'trading')).toBe(true);
  });
});

describe('attributeAll', () => {
  it('produces a breakdown per requested dimension', () => {
    const all = attributeAll(events, ['provider', 'tenantId']);
    expect(Object.keys(all)).toEqual(['provider', 'tenantId']);
    expect(all.tenantId[0].key).toBe('alma');
  });

  it('defaults to every canonical dimension', () => {
    const all = attributeAll(events);
    expect(Object.keys(all).sort()).toEqual([...ATTRIBUTION_DIMENSIONS].sort());
  });
});
