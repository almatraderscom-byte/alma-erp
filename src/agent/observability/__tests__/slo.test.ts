import { describe, it, expect } from 'vitest';
import { evaluateSlo, DEFAULT_AGENT_SLO } from '../slo';

describe('agent SLOs (SPEC-192)', () => {
  it('MET when the window satisfies every objective', () => {
    const r = evaluateSlo(DEFAULT_AGENT_SLO, { total: 100, succeeded: 98, p95LatencyMs: 12000, costPerSuccessNanoUsd: 200_000_000 });
    expect(r.ok).toBe(true);
    expect(r.breaches).toEqual([]);
    expect(r.successRate).toBeCloseTo(0.98);
  });
  it('BREACHES a low success rate', () => {
    expect(evaluateSlo(DEFAULT_AGENT_SLO, { total: 100, succeeded: 80, p95LatencyMs: 1000, costPerSuccessNanoUsd: 1 }).breaches).toContain('success_rate');
  });
  it('BREACHES high latency and high cost', () => {
    const r = evaluateSlo(DEFAULT_AGENT_SLO, { total: 100, succeeded: 100, p95LatencyMs: 99999, costPerSuccessNanoUsd: 999_000_000 });
    expect(r.breaches).toContain('p95_latency');
    expect(r.breaches).toContain('cost_per_success');
  });
  it('BREACHES no_data on an empty window (fail-closed)', () => {
    expect(evaluateSlo(DEFAULT_AGENT_SLO, { total: 0, succeeded: 0, p95LatencyMs: 0, costPerSuccessNanoUsd: 0 }).ok).toBe(false);
  });
});
