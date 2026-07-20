import { describe, it, expect } from 'vitest';
import { runBrowserChaosSuite } from '../chaos';

describe('browser chaos certification (SPEC-150)', () => {
  const results = runBrowserChaosSuite();

  it('runs a non-trivial number of invariants', () => {
    expect(results.length).toBeGreaterThanOrEqual(8);
  });

  for (const r of results) {
    it(`holds: ${r.invariant}`, () => {
      expect(r.ok).toBe(true);
    });
  }

  it('every browser invariant holds', () => {
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
