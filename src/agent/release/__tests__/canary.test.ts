import { describe, it, expect } from 'vitest';
import { cohortBucket, inCanary, isMonotonicGrowth } from '../canary';

describe('canary release (SPEC-196)', () => {
  it('bucket is deterministic and in 0..99', () => {
    expect(cohortBucket('req-1')).toBe(cohortBucket('req-1'));
    expect(cohortBucket('req-1')).toBeGreaterThanOrEqual(0);
    expect(cohortBucket('req-1')).toBeLessThan(100);
  });
  it('0% excludes everyone, 100% includes everyone', () => {
    expect(inCanary('anything', 0)).toBe(false);
    expect(inCanary('anything', 100)).toBe(true);
  });
  it('membership is monotonic as the percentage grows', () => {
    const keys = Array.from({ length: 50 }, (_, i) => `req-${i}`);
    for (const k of keys) expect(isMonotonicGrowth(k, 10, 50)).toBe(true);
  });
  it('a 50% rollout includes roughly half (deterministic spread)', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k-${i}`);
    const inCount = keys.filter((k) => inCanary(k, 50)).length;
    expect(inCount).toBeGreaterThan(60);
    expect(inCount).toBeLessThan(140);
  });
});
