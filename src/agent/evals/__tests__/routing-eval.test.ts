import { describe, it, expect } from 'vitest';
import { evaluateRouting, hasCriticalUnderRouting } from '../routing-eval';

describe('routing evaluation (SPEC-185)', () => {
  it('scores perfect routing as accuracy 1', () => {
    const obs = [
      { taskId: 'g-order-status', tier: 'LIGHT' },
      { taskId: 'g-publish-post', tier: 'HEAVY' },
      { taskId: 'g-refund', tier: 'CRITICAL' },
      { taskId: 'g-payroll', tier: 'CRITICAL' },
      { taskId: 'g-research', tier: 'HEAVY' },
    ];
    const r = evaluateRouting(obs);
    expect(r.accuracy).toBe(1);
    expect(r.misroutes).toEqual([]);
    expect(hasCriticalUnderRouting(r)).toBe(false);
  });
  it('flags a CRITICAL money task under-routed to a cheaper tier', () => {
    const r = evaluateRouting([{ taskId: 'g-refund', tier: 'LIGHT' }]);
    expect(r.correct).toBe(0);
    expect(hasCriticalUnderRouting(r)).toBe(true);
  });
  it('only scores tasks that were observed', () => {
    const r = evaluateRouting([{ taskId: 'g-order-status', tier: 'LIGHT' }]);
    expect(r.scored).toBe(1);
    expect(r.accuracy).toBe(1);
  });
});
