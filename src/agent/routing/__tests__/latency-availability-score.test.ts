import { describe, it, expect } from 'vitest';
import { speedMilli, latencyAvailabilityScore, scoreRecordLatencyAvailability } from '../latency-availability-score';
import type { PerfRecord } from '../performance-records';

describe('SPEC-163 latency-availability score', () => {
  it('speed: 1000 at 0ms, 0 at/over reference and unknown sentinel', () => {
    expect(speedMilli(0, 1000)).toBe(1000);
    expect(speedMilli(250, 1000)).toBe(750);
    expect(speedMilli(1000, 1000)).toBe(0);
    expect(speedMilli(Number.MAX_SAFE_INTEGER, 1000)).toBe(0);
    expect(speedMilli(100, 0)).toBe(0);
  });

  it('combines availability and speed (default 500/500)', () => {
    expect(latencyAvailabilityScore({ availabilityMilli: 1000, avgLatencyMs: 0, refLatencyMs: 1000 })).toBe(1000);
    expect(latencyAvailabilityScore({ availabilityMilli: 1000, avgLatencyMs: 1000, refLatencyMs: 1000 })).toBe(500); // speed 0
    expect(latencyAvailabilityScore({ availabilityMilli: 800, avgLatencyMs: 600, refLatencyMs: 1000 })).toBe(Math.floor((800 * 500 + 400 * 500) / 1000));
  });

  it('a faster, more-available model scores higher', () => {
    const good = latencyAvailabilityScore({ availabilityMilli: 990, avgLatencyMs: 200, refLatencyMs: 5000 });
    const bad = latencyAvailabilityScore({ availabilityMilli: 700, avgLatencyMs: 4000, refLatencyMs: 5000 });
    expect(good).toBeGreaterThan(bad);
  });

  it('zero-sample record → 0 (fail-safe: unmeasured never wins)', () => {
    const empty: PerfRecord = { taskClass: 't', provider: 'p', model: 'm', samples: 0, successes: 0, qualityMilliSum: 0, latencyMsSum: 0, costNanoUsdSum: 0 };
    expect(scoreRecordLatencyAvailability(empty, 5000)).toBe(0);
  });

  it('a flaky (low success) model is penalised even when fast', () => {
    const flakyFast: PerfRecord = { taskClass: 't', provider: 'p', model: 'a', samples: 10, successes: 3, qualityMilliSum: 9000, latencyMsSum: 1000, costNanoUsdSum: 0 };
    const solidSlower: PerfRecord = { taskClass: 't', provider: 'p', model: 'b', samples: 10, successes: 10, qualityMilliSum: 9000, latencyMsSum: 20000, costNanoUsdSum: 0 };
    // availability 300 vs 1000; even with worse latency the reliable one wins here
    expect(scoreRecordLatencyAvailability(solidSlower, 5000)).toBeGreaterThan(scoreRecordLatencyAvailability(flakyFast, 5000));
  });

  it('rejects malformed weights (fail closed)', () => {
    expect(() => latencyAvailabilityScore({ availabilityMilli: 500, avgLatencyMs: 100, refLatencyMs: 1000 }, { availabilityWeightMilli: 600, speedWeightMilli: 500 })).toThrow();
  });
});
