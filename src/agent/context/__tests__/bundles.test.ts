import { describe, it, expect } from 'vitest';
import { DEFAULT_ALMA_CONSTITUTION, constitutionBundle } from '../../prompts/bundles';
import { compile } from '../compiler';

describe('constitutionBundle (SPEC-042)', () => {
  it('is a cacheable constitution-kind bundle', () => {
    const b = constitutionBundle();
    expect(b.kind).toBe('constitution');
    expect(b.cacheable).toBe(true);
  });
  it('defaults to the ALMA constitution (Boss-only, Bangla, guardrails)', () => {
    expect(constitutionBundle().content).toBe(DEFAULT_ALMA_CONSTITUTION);
    expect(DEFAULT_ALMA_CONSTITUTION).toMatch(/Boss/);
    // carries the Boss-only rule (the word "Sir" appears only inside "never Sir")
    expect(DEFAULT_ALMA_CONSTITUTION).toMatch(/never "Sir"/);
  });
  it('accepts an owner override + version', () => {
    const b = constitutionBundle('custom rules', '2');
    expect(b.content).toBe('custom rules');
    expect(b.version).toBe('2');
  });
  it('sits at the front of the cacheable prefix when compiled', () => {
    const c = compile([constitutionBundle()]);
    expect(c.provenance[0].kind).toBe('constitution');
    expect(c.cacheablePrefixTokens).toBe(c.totalTokens);
  });
});
