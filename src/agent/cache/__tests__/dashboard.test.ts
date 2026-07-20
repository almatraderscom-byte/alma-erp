import { describe, it, expect } from 'vitest';
import { computeSavings, type CacheEvent } from '../dashboard';
import { usdToNano } from '../../providers/pricing/registry';

const ev = (over: Partial<CacheEvent>): CacheEvent => ({ kind: 'exact', hit: true, savedNanoUsd: 0, correctnessVerified: true, ...over });

describe('cache savings dashboard (SPEC-070)', () => {
  it('sums saved money and hit rate', () => {
    const r = computeSavings([
      ev({ hit: true, savedNanoUsd: usdToNano(0.02) }),
      ev({ hit: false, savedNanoUsd: 0 }),
      ev({ hit: true, savedNanoUsd: usdToNano(0.03) }),
    ]);
    expect(r.hits).toBe(2);
    expect(r.misses).toBe(1);
    expect(r.hitRate).toBeCloseTo(2 / 3);
    expect(r.savedNanoUsd).toBe(usdToNano(0.05));
  });
  it('breaks savings down by cache kind', () => {
    const r = computeSavings([ev({ kind: 'prefix', savedNanoUsd: 100 }), ev({ kind: 'exact', savedNanoUsd: 200 })]);
    expect(r.byKind.prefix.savedNanoUsd).toBe(100);
    expect(r.byKind.exact.hits).toBe(1);
  });
  it('reports verified-hit rate (correctness signal)', () => {
    const r = computeSavings([ev({ hit: true, correctnessVerified: true }), ev({ hit: true, correctnessVerified: false })]);
    expect(r.verifiedHitRate).toBe(0.5);
  });
  it('empty -> zero everything, hitRate 0, verified 1', () => {
    const r = computeSavings([]);
    expect(r).toMatchObject({ total: 0, hits: 0, savedNanoUsd: 0, hitRate: 0, verifiedHitRate: 1 });
  });
});
