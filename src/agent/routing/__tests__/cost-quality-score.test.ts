import { describe, it, expect } from 'vitest';
import { cheapnessMilli, costQualityScore, scoreRecordCostQuality, DEFAULT_COST_QUALITY_WEIGHTS } from '../cost-quality-score';
import type { PerfRecord } from '../performance-records';

describe('SPEC-162 cost-quality score', () => {
  it('cheapness: 1000 at cost 0, 0 at/over reference', () => {
    expect(cheapnessMilli(0, 1000)).toBe(1000);
    expect(cheapnessMilli(500, 1000)).toBe(500);
    expect(cheapnessMilli(1000, 1000)).toBe(0);
    expect(cheapnessMilli(2000, 1000)).toBe(0); // over reference
    expect(cheapnessMilli(Number.MAX_SAFE_INTEGER, 1000)).toBe(0); // unknown sentinel
    expect(cheapnessMilli(100, 0)).toBe(0); // no reference → fail-safe
  });

  it('combines quality and cheapness by weight (default 600/400)', () => {
    // quality 1000, cost 0 → 1000*0.6 + 1000*0.4 = 1000
    expect(costQualityScore({ qualityMilli: 1000, avgCostNanoUsd: 0, refCostNanoUsd: 1000 })).toBe(1000);
    // quality 1000 but at reference cost → cheapness 0 → 600
    expect(costQualityScore({ qualityMilli: 1000, avgCostNanoUsd: 1000, refCostNanoUsd: 1000 })).toBe(600);
    // quality 500, cost half → 500*0.6 + 500*0.4 = 500
    expect(costQualityScore({ qualityMilli: 500, avgCostNanoUsd: 500, refCostNanoUsd: 1000 })).toBe(500);
  });

  it('a cheaper equal-quality model scores higher (the point of the metric)', () => {
    const cheap = costQualityScore({ qualityMilli: 900, avgCostNanoUsd: 200, refCostNanoUsd: 2000 });
    const dear = costQualityScore({ qualityMilli: 900, avgCostNanoUsd: 1800, refCostNanoUsd: 2000 });
    expect(cheap).toBeGreaterThan(dear);
  });

  it('a model with unknown cost cannot out-score a measured cheaper one (fail-safe)', () => {
    const measured: PerfRecord = { taskClass: 't', provider: 'p', model: 'a', samples: 5, successes: 5, qualityMilliSum: 4000, latencyMsSum: 1000, costNanoUsdSum: 1000 };
    const unknownCost: PerfRecord = { taskClass: 't', provider: 'p', model: 'b', samples: 0, successes: 0, qualityMilliSum: 0, latencyMsSum: 0, costNanoUsdSum: 0 };
    expect(scoreRecordCostQuality(measured, 5000)).toBeGreaterThan(scoreRecordCostQuality(unknownCost, 5000));
    expect(scoreRecordCostQuality(unknownCost, 5000)).toBe(0);
  });

  it('rejects malformed weights (fail closed)', () => {
    expect(() => costQualityScore({ qualityMilli: 500, avgCostNanoUsd: 100, refCostNanoUsd: 1000 }, { qualityWeightMilli: 700, cheapnessWeightMilli: 400 })).toThrow();
    expect(() => costQualityScore({ qualityMilli: 500, avgCostNanoUsd: 100, refCostNanoUsd: 1000 }, { qualityWeightMilli: -1, cheapnessWeightMilli: 1001 })).toThrow();
  });

  it('is deterministic and clamps quality to [0..1000]', () => {
    expect(costQualityScore({ qualityMilli: 5000, avgCostNanoUsd: 0, refCostNanoUsd: 1000 }, DEFAULT_COST_QUALITY_WEIGHTS)).toBe(1000);
  });
});
