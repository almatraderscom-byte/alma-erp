import { describe, it, expect } from 'vitest';
import { evaluateRelease, RELEASE_REASON_CODES, type ReleaseInput } from '../release-gate';

const good: ReleaseInput = {
  routing: { total: 5, scored: 5, correct: 5, accuracy: 1, misroutes: [] },
  toolSelection: { scored: 5, meanPrecision: 1, meanRecall: 1, perTask: [] },
  cost: { scored: 5, successCount: 5, totalNanoUsd: 1000, costPerSuccessNanoUsd: 200, failures: [] },
  thresholds: { minRoutingAccuracy: 0.9, minToolPrecision: 0.9, minToolRecall: 0.9, maxCostPerSuccessNanoUsd: 500 },
};

describe('quality & security release gate (SPEC-190)', () => {
  it('ALLOWS release when all quality thresholds pass and security is clean', () => {
    expect(evaluateRelease(good).status).toBe('ALLOWED');
  });
  it('DENIES on low routing accuracy', () => {
    const r = evaluateRelease({ ...good, routing: { ...good.routing, accuracy: 0.5 } });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RELEASE_REASON_CODES.ROUTING_ACCURACY);
  });
  it('DENIES on a CRITICAL under-route even if accuracy is otherwise high', () => {
    const r = evaluateRelease({ ...good, routing: { ...good.routing, accuracy: 0.95, misroutes: [{ taskId: 'g-refund', expected: 'CRITICAL', actual: 'LIGHT', critical: true }] } });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RELEASE_REASON_CODES.CRITICAL_UNDER_ROUTE);
  });
  it('DENIES on cost regression', () => {
    const r = evaluateRelease({ ...good, cost: { ...good.cost, costPerSuccessNanoUsd: 999 } });
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(RELEASE_REASON_CODES.COST_REGRESSED);
  });
  it('DENIES on low tool precision/recall', () => {
    expect(evaluateRelease({ ...good, toolSelection: { ...good.toolSelection, meanPrecision: 0.5 } }).status).toBe('DENIED');
  });
});
