import { describe, it, expect } from 'vitest';
import { routeModel, ROUTABLE_TIERS, isFrontierTier, type RouteQuery } from '../measured-router';
import { InMemoryPerformanceRecordStore, type PerfObservation } from '../performance-records';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';

const identity: ExecutionIdentity = {
  tenantId: 'alma', actorId: 'owner:maruf', workflowId: 'wf', stepId: 's1', correlationId: 'c1',
};
const req = (payload: RouteQuery, id: Partial<ExecutionIdentity> = {}) => ({
  identity: { ...identity, ...id }, contractVersion: '1.0.0', payload,
});
const seed = (store: InMemoryPerformanceRecordStore, o: PerfObservation, n: number) => {
  for (let i = 0; i < n; i++) store.observe(o);
};

describe('SPEC-164 measured router — frozen invariant (no frontier default)', () => {
  it('refuses to route the frontier tier T4 → DENIED', () => {
    const res = routeModel(req({ taskClass: 'reason', tier: 'T4' }), { records: new InMemoryPerformanceRecordStore() });
    expect(res.status).toBe('DENIED');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('ROUTE_FRONTIER_FORBIDDEN');
  });

  it('refuses the deterministic tier T0 (code-only)', () => {
    const res = routeModel(req({ taskClass: 'x', tier: 'T0' }), { records: new InMemoryPerformanceRecordStore() });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('ROUTE_TIER_NOT_ROUTABLE');
  });

  it('ROUTABLE_TIERS excludes T0 and T4', () => {
    expect(ROUTABLE_TIERS).toEqual(['T1', 'T2', 'T3']);
    expect(isFrontierTier('T4')).toBe(true);
    expect(ROUTABLE_TIERS.some(isFrontierTier)).toBe(false);
  });
});

describe('SPEC-164 measured router — measured selection', () => {
  it('picks the best-measured candidate, even when it is NOT the registry primary', () => {
    const store = new InMemoryPerformanceRecordStore();
    // T3 candidates: google/gemini-3.1-pro (primary), openrouter/or-qwen3-max (2nd)
    seed(store, { taskClass: 'reason', provider: 'google', model: 'gemini-3.1-pro', success: true, qualityMilli: 600, latencyMs: 1000, costNanoUsd: 10000 }, 5);
    seed(store, { taskClass: 'reason', provider: 'openrouter', model: 'or-qwen3-max', success: true, qualityMilli: 950, latencyMs: 800, costNanoUsd: 6000 }, 5);
    const res = routeModel(req({ taskClass: 'reason', tier: 'T3' }), { records: store });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.model).toBe('or-qwen3-max'); // measured winner, not the primary
      expect(res.value.basis).toBe('measured');
      expect(res.value.score).toBeGreaterThan(0);
      expect(isFrontierTier(res.value.tier)).toBe(false); // never frontier
    }
  });

  it('fail-safe: no telemetry → registry PRIMARY (cheapest safe default), never frontier', () => {
    const res = routeModel(req({ taskClass: 'reason', tier: 'T3' }), { records: new InMemoryPerformanceRecordStore() });
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.basis).toBe('default-primary');
      expect(res.value.model).toBe('gemini-3.1-pro'); // T3 primary
      expect(isFrontierTier(res.value.tier)).toBe(false);
    }
  });

  it('is deterministic — same inputs → same decision', () => {
    const mk = () => {
      const s = new InMemoryPerformanceRecordStore();
      seed(s, { taskClass: 'reason', provider: 'google', model: 'gemini-3.1-pro', success: true, qualityMilli: 900, latencyMs: 500, costNanoUsd: 8000 }, 3);
      seed(s, { taskClass: 'reason', provider: 'openrouter', model: 'or-qwen3-max', success: true, qualityMilli: 900, latencyMs: 500, costNanoUsd: 8000 }, 3);
      return routeModel(req({ taskClass: 'reason', tier: 'T3' }), { records: s });
    };
    expect(mk()).toEqual(mk());
  });
});

describe('SPEC-164 measured router — fail closed', () => {
  it('missing identity → FAILED_FINAL', () => {
    const res = routeModel(req({ taskClass: 'reason', tier: 'T3' }, { tenantId: '' }), { records: new InMemoryPerformanceRecordStore() });
    expect(res.status).toBe('FAILED_FINAL');
  });

  it('required capability none of the candidates has → CAPABILITY_UNSUPPORTED', () => {
    // T2 candidates are deepseek/qwen — neither declares vision
    const res = routeModel(req({ taskClass: 'specialist', tier: 'T2', requiredCapabilities: ['vision'] }), { records: new InMemoryPerformanceRecordStore() });
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('ROUTE_CAPABILITY_UNSUPPORTED');
  });
});
