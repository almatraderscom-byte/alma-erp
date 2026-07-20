import { describe, it, expect } from 'vitest';
import { isCacheable, type CacheEligibility } from '../exclusions';

const base: CacheEligibility = { intent: 'question', risk: 'LOW', hasSideEffect: false, permissionDependent: false };

describe('cache exclusions (SPEC-068) — fail-closed', () => {
  it('allows a read-only, low-risk, no-side-effect response', () => {
    expect(isCacheable(base).cacheable).toBe(true);
  });
  it('NEVER caches a side-effecting response', () => {
    expect(isCacheable({ ...base, hasSideEffect: true }).cacheable).toBe(false);
  });
  it('NEVER caches a permission-dependent response', () => {
    expect(isCacheable({ ...base, permissionDependent: true }).cacheable).toBe(false);
  });
  it('NEVER caches a HIGH-risk (money/destructive) response', () => {
    expect(isCacheable({ ...base, risk: 'HIGH' }).cacheable).toBe(false);
  });
  it('NEVER caches a non-read-only intent (task/command)', () => {
    expect(isCacheable({ ...base, intent: 'task' }).cacheable).toBe(false);
  });
});
