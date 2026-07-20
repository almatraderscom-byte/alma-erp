import { describe, it, expect } from 'vitest';
import { skillBundle } from '../../prompts/bundles';
import { constitutionBundle } from '../../prompts/bundles';
import { compile } from '../compiler';

describe('skillBundle (SPEC-043)', () => {
  it('is a cacheable skill bundle keyed by skill id', () => {
    const b = skillBundle('orders', 'handle orders');
    expect(b.kind).toBe('skill');
    expect(b.cacheable).toBe(true);
    expect(b.id).toBe('skill:orders');
  });
  it('compiles after the constitution, inside the cacheable prefix', () => {
    const c = compile([skillBundle('orders', 'S'), constitutionBundle()]);
    expect(c.provenance.map((p) => p.kind)).toEqual(['constitution', 'skill']);
    expect(c.cacheablePrefixTokens).toBe(c.totalTokens); // both cacheable
  });
});
