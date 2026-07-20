import { describe, it, expect } from 'vitest';
import { constitutionBundle, memoryBundle, requestSuffixBundle } from '../../prompts/bundles';
import { compile } from '../compiler';

describe('requestSuffixBundle (SPEC-048)', () => {
  it('is a dynamic request_suffix bundle carrying the user text', () => {
    const b = requestSuffixBundle('koto order holo?');
    expect(b.kind).toBe('request_suffix');
    expect(b.cacheable).toBe(false);
    expect(b.content).toContain('koto order holo?');
  });
  it('always compiles LAST (highest order)', () => {
    const c = compile([requestSuffixBundle('Q'), memoryBundle(['m']), constitutionBundle()]);
    expect(c.provenance[c.provenance.length - 1].kind).toBe('request_suffix');
  });
});
