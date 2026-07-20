import { describe, it, expect } from 'vitest';
import { runQueueChaosSuite } from '../chaos';

describe('queue chaos certification (SPEC-150)', () => {
  const results = runQueueChaosSuite();

  it('runs a non-trivial number of invariants', () => {
    expect(results.length).toBeGreaterThanOrEqual(10);
  });

  for (const r of results) {
    it(`holds: ${r.invariant}`, () => {
      expect(r.ok).toBe(true);
    });
  }

  it('every queue invariant holds', () => {
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
