import { describe, it, expect } from 'vitest';
import { runPolicyBypassSuite, certifyNoBypass } from '../bypass-suite';

describe('policy & permission bypass suite (SPEC-189)', () => {
  it('EVERY bypass attack is blocked', () => {
    const leaked = runPolicyBypassSuite().filter((r) => !r.blocked);
    expect(leaked.map((l) => l.attack)).toEqual([]);
  });
  it('certifies no bypass with a non-trivial attack count', () => {
    const c = certifyNoBypass();
    expect(c.ok).toBe(true);
    expect(c.leaked).toEqual([]);
    expect(c.total).toBeGreaterThanOrEqual(8);
  });
});
