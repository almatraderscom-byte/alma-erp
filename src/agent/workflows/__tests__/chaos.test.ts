import { describe, it, expect } from 'vitest';
import { runWorkflowChaosSuite, certifyWorkflowDurability } from '../chaos';

describe('workflow durability chaos certification (SPEC-140)', () => {
  it('EVERY durability invariant holds across the composed runtime', () => {
    const failed = runWorkflowChaosSuite().filter((r) => !r.ok);
    expect(failed.map((f) => f.invariant)).toEqual([]);
  });
  it('certifies durability with a non-trivial invariant count', () => {
    const c = certifyWorkflowDurability();
    expect(c.ok).toBe(true);
    expect(c.failed).toEqual([]);
    expect(c.total).toBeGreaterThanOrEqual(12);
  });
  it('covers the safety-critical scenarios (reconcile / idempotency / lease / compensation)', () => {
    const names = runWorkflowChaosSuite().map((r) => r.invariant).join(' | ');
    expect(names).toMatch(/reconcile/);
    expect(names).toMatch(/only once/);
    expect(names).toMatch(/lease/);
    expect(names).toMatch(/compensate/);
  });
});
