import { describe, it, expect } from 'vitest';
import { runAutonomyFailClosedSuite, certifyAutonomyFailClosed } from '../adversarial';

describe('autonomy & approval adversarial certification (SPEC-120)', () => {
  it('EVERY fail-closed invariant holds across the wired stack', () => {
    const results = runAutonomyFailClosedSuite();
    const failed = results.filter((r) => !r.ok);
    // Surface exactly which invariant broke, if any.
    expect(failed.map((f) => f.invariant)).toEqual([]);
  });

  it('certifies the whole stack (ok, with a non-trivial invariant count)', () => {
    const cert = certifyAutonomyFailClosed();
    expect(cert.ok).toBe(true);
    expect(cert.failed).toEqual([]);
    expect(cert.total).toBeGreaterThanOrEqual(20);
  });

  it('includes both positive (autonomous IS allowed) and negative (attacks blocked) invariants', () => {
    const names = runAutonomyFailClosedSuite().map((r) => r.invariant);
    expect(names.some((n) => n.includes('IS autonomous') || n.includes('→ usable'))).toBe(true);
    expect(names.some((n) => n.includes('self-approval') || n.includes('replay') || n.includes('revoked'))).toBe(true);
  });
});
