import { describe, it, expect } from 'vitest';
import { constitutionBundle, policyBundle, skillBundle } from '../../prompts/bundles';
import { compile } from '../compiler';

describe('policyBundle (SPEC-044)', () => {
  it('is a cacheable policy bundle', () => {
    const b = policyBundle('no destructive actions without approval', '2');
    expect(b.kind).toBe('policy');
    expect(b.cacheable).toBe(true);
    expect(b.version).toBe('2');
  });
  it('compiles after constitution + skill, still within the cacheable prefix', () => {
    const c = compile([policyBundle('P'), constitutionBundle(), skillBundle('orders', 'S')]);
    expect(c.provenance.map((p) => p.kind)).toEqual(['constitution', 'skill', 'policy']);
    expect(c.cacheablePrefixTokens).toBe(c.totalTokens);
  });
});
