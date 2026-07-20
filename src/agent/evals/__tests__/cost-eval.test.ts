import { describe, it, expect } from 'vitest';
import { evaluateCostPerSuccess, costPerSuccessRegressed } from '../cost-eval';

describe('cost-per-success evaluation (SPEC-187)', () => {
  it('computes nano-USD per successful task', () => {
    const r = evaluateCostPerSuccess([
      { taskId: 'g-order-status', actualNanoUsd: 100, succeeded: true },
      { taskId: 'g-refund', actualNanoUsd: 300, succeeded: true },
    ]);
    expect(r.totalNanoUsd).toBe(400);
    expect(r.successCount).toBe(2);
    expect(r.costPerSuccessNanoUsd).toBe(200);
  });
  it('a failing task inflates cost-per-success (cheap-but-failing is not cheap)', () => {
    const r = evaluateCostPerSuccess([
      { taskId: 'g-order-status', actualNanoUsd: 100, succeeded: true },
      { taskId: 'g-refund', actualNanoUsd: 300, succeeded: false },
    ]);
    expect(r.costPerSuccessNanoUsd).toBe(400); // 400 total / 1 success
    expect(r.failures).toContain('g-refund');
  });
  it('Infinity when nothing succeeds, and that regresses', () => {
    const r = evaluateCostPerSuccess([{ taskId: 'g-order-status', actualNanoUsd: 100, succeeded: false }]);
    expect(r.costPerSuccessNanoUsd).toBe(Infinity);
    expect(costPerSuccessRegressed(r, 1000)).toBe(true);
  });
  it('ignores malformed (float/negative) cost and unknown tasks', () => {
    const r = evaluateCostPerSuccess([
      { taskId: 'g-order-status', actualNanoUsd: 1.5, succeeded: true },
      { taskId: 'unknown', actualNanoUsd: 100, succeeded: true },
    ]);
    expect(r.scored).toBe(0);
  });
});
