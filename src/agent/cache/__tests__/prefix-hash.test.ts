import { describe, it, expect } from 'vitest';
import { cacheablePrefixProvenance, prefixCacheKey } from '../prefix-hash';
import { compile } from '../../context/compiler';
import { constitutionBundle, memoryBundle, policyBundle, requestSuffixBundle, skillBundle } from '../../prompts/bundles';

const stablePrefix = () => [constitutionBundle('rules'), skillBundle('orders', 'S'), policyBundle('P')];

describe('stable-prefix hashing (SPEC-061)', () => {
  it('extracts only the leading cacheable bundles', () => {
    const c = compile([...stablePrefix(), memoryBundle(['m']), requestSuffixBundle('q')]);
    expect(cacheablePrefixProvenance(c).map((p) => p.kind)).toEqual(['constitution', 'skill', 'policy']);
  });

  it('is deterministic for the same prefix', () => {
    const a = compile([...stablePrefix(), requestSuffixBundle('q1')]);
    const b = compile([...stablePrefix(), requestSuffixBundle('q2')]);
    expect(prefixCacheKey(a)).toBe(prefixCacheKey(b)); // dynamic suffix differs, prefix same
  });

  it('KEY IS UNAFFECTED by dynamic memory/request changes (the whole point)', () => {
    const base = compile([...stablePrefix(), requestSuffixBundle('hi')]);
    const withMem = compile([...stablePrefix(), memoryBundle(['lots', 'of', 'memory']), requestSuffixBundle('totally different')]);
    expect(prefixCacheKey(withMem)).toBe(prefixCacheKey(base));
  });

  it('KEY CHANGES when a cacheable bundle version changes (cache correctly invalidates)', () => {
    const v1 = compile([constitutionBundle('rules', '1'), requestSuffixBundle('q')]);
    const v2 = compile([constitutionBundle('rules', '2'), requestSuffixBundle('q')]);
    expect(prefixCacheKey(v1)).not.toBe(prefixCacheKey(v2));
  });

  it('key is prefixed + fixed length', () => {
    expect(prefixCacheKey(compile([constitutionBundle('x')]))).toMatch(/^pfx_[0-9a-f]{32}$/);
  });
});
