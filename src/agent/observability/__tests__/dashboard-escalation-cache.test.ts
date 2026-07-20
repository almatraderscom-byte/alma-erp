import { describe, it, expect } from 'vitest';
import { buildEscalationCacheDashboard } from '../dashboard-escalation-cache';

describe('escalation & cache dashboard (SPEC-194)', () => {
  it('aggregates escalations by kind', () => {
    const d = buildEscalationCacheDashboard([{ kind: 'approval', count: 5 }, { kind: 'approval', count: 2 }, { kind: 'frontier', count: 1 }], []);
    expect(d.escalationsByKind.approval).toBe(7);
    expect(d.totalEscalations).toBe(8);
  });
  it('computes cache hit rate and savings', () => {
    const d = buildEscalationCacheDashboard([], [{ lookups: 10, hits: 7, savedNanoUsd: 500 }, { lookups: 10, hits: 3, savedNanoUsd: 200 }]);
    expect(d.cacheHitRate).toBeCloseTo(0.5);
    expect(d.cacheSavedNanoUsd).toBe(700);
  });
  it('clamps hits to lookups and ignores malformed rows', () => {
    const d = buildEscalationCacheDashboard([{ kind: 'opus', count: -1 }], [{ lookups: 5, hits: 99, savedNanoUsd: 1.5 }]);
    expect(d.totalEscalations).toBe(0);
    expect(d.cacheHitRate).toBe(1); // hits clamped to 5/5
    expect(d.cacheSavedNanoUsd).toBe(0); // float ignored
  });
});
