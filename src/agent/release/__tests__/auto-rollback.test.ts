import { describe, it, expect } from 'vitest';
import { decideRollback, type ReleaseMetrics, type RollbackThresholds } from '../auto-rollback';

const baseline: ReleaseMetrics = { samples: 1000, successRate: 0.98, p95LatencyMs: 10000, costPerSuccessNanoUsd: 200_000_000 };
const t: RollbackThresholds = { minSamples: 100, maxSuccessRateDrop: 0.02, maxLatencyIncreaseMs: 5000, maxCostIncreaseNanoUsd: 50_000_000 };

describe('auto-rollback thresholds (SPEC-197)', () => {
  it('CONTINUE when canary matches or beats baseline', () => {
    expect(decideRollback(baseline, { ...baseline, successRate: 0.99 }, t).decision).toBe('CONTINUE');
  });
  it('ROLLBACK on a success-rate drop beyond threshold', () => {
    const r = decideRollback(baseline, { ...baseline, successRate: 0.90 }, t);
    expect(r.decision).toBe('ROLLBACK');
    expect(r.reasons).toContain('success_rate_drop');
  });
  it('ROLLBACK on latency or cost regression', () => {
    expect(decideRollback(baseline, { ...baseline, p95LatencyMs: 20000 }, t).decision).toBe('ROLLBACK');
    expect(decideRollback(baseline, { ...baseline, costPerSuccessNanoUsd: 999_000_000 }, t).decision).toBe('ROLLBACK');
  });
  it('HALT (fail-closed) when there is not enough canary data', () => {
    expect(decideRollback(baseline, { ...baseline, samples: 10 }, t).decision).toBe('HALT');
  });
});
