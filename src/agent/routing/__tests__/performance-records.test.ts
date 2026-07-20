import { describe, it, expect } from 'vitest';
import {
  InMemoryPerformanceRecordStore,
  successRateMilli,
  avgQualityMilli,
  avgLatencyMs,
  avgCostNanoUsd,
  type PerfObservation,
} from '../performance-records';

const obs = (over: Partial<PerfObservation> = {}): PerfObservation => ({
  taskClass: 'classify',
  provider: 'openrouter',
  model: 'or-deepseek-v4-flash',
  success: true,
  qualityMilli: 900,
  latencyMs: 400,
  costNanoUsd: 1200,
  ...over,
});

describe('SPEC-161 performance records', () => {
  it('aggregates observations deterministically (integer sums)', () => {
    const s = new InMemoryPerformanceRecordStore();
    s.observe(obs({ qualityMilli: 800, latencyMs: 300, costNanoUsd: 1000 }));
    s.observe(obs({ qualityMilli: 900, latencyMs: 500, costNanoUsd: 2000, success: false }));
    const r = s.get('classify', 'openrouter', 'or-deepseek-v4-flash')!;
    expect(r.samples).toBe(2);
    expect(r.successes).toBe(1);
    expect(r.qualityMilliSum).toBe(1700);
    expect(successRateMilli(r)).toBe(500); // 1/2
    expect(avgQualityMilli(r)).toBe(850);
    expect(avgLatencyMs(r)).toBe(400);
    expect(avgCostNanoUsd(r)).toBe(1500);
  });

  it('zero samples → rate/quality 0, latency/cost worst sentinel (fail-safe)', () => {
    const empty = { taskClass: 't', provider: 'p', model: 'm', samples: 0, successes: 0, qualityMilliSum: 0, latencyMsSum: 0, costNanoUsdSum: 0 };
    expect(successRateMilli(empty)).toBe(0);
    expect(avgQualityMilli(empty)).toBe(0);
    expect(avgLatencyMs(empty)).toBe(Number.MAX_SAFE_INTEGER); // unknown = worst, never fastest
    expect(avgCostNanoUsd(empty)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid observations (fail closed)', () => {
    const s = new InMemoryPerformanceRecordStore();
    expect(() => s.observe(obs({ qualityMilli: 1001 }))).toThrow();
    expect(() => s.observe(obs({ latencyMs: -1 }))).toThrow();
    expect(() => s.observe(obs({ costNanoUsd: -5 }))).toThrow();
    expect(() => s.observe(obs({ taskClass: '' }))).toThrow();
  });

  it('list is deterministically ordered and task-class scoped', () => {
    const s = new InMemoryPerformanceRecordStore();
    s.observe(obs({ provider: 'google', model: 'gemini-3.1-pro' }));
    s.observe(obs({ provider: 'openrouter', model: 'or-qwen3-max' }));
    s.observe(obs({ taskClass: 'reason', provider: 'google', model: 'gemini-3.1-pro' }));
    const list = s.list('classify');
    expect(list.map((r) => r.provider)).toEqual(['google', 'openrouter']); // sorted
    expect(list.every((r) => r.taskClass === 'classify')).toBe(true);
  });

  it('same observations in any order → identical aggregate (deterministic)', () => {
    const a = new InMemoryPerformanceRecordStore();
    const b = new InMemoryPerformanceRecordStore();
    a.observe(obs({ qualityMilli: 100 }));
    a.observe(obs({ qualityMilli: 900 }));
    b.observe(obs({ qualityMilli: 900 }));
    b.observe(obs({ qualityMilli: 100 }));
    expect(a.get('classify', 'openrouter', 'or-deepseek-v4-flash')).toEqual(
      b.get('classify', 'openrouter', 'or-deepseek-v4-flash'),
    );
  });
});
