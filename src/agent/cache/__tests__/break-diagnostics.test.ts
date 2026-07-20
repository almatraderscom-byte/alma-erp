import { describe, it, expect } from 'vitest';
import { diagnoseBreak, explainBreak } from '../break-diagnostics';
import { compile } from '../../context/compiler';
import { constitutionBundle, policyBundle, requestSuffixBundle, skillBundle } from '../../prompts/bundles';

describe('cache-break diagnostics (SPEC-063)', () => {
  it('reports no break when the prefix is unchanged', () => {
    const a = compile([constitutionBundle('r'), requestSuffixBundle('q1')]);
    const b = compile([constitutionBundle('r'), requestSuffixBundle('q2')]);
    expect(explainBreak(a, b).broke).toBe(false);
  });
  it('detects a version change', () => {
    const a = compile([constitutionBundle('r', '1')]);
    const b = compile([constitutionBundle('r', '2')]);
    const r = diagnoseBreak(a, b);
    expect(r[0].change).toBe('version_changed');
  });
  it('detects an added cacheable bundle', () => {
    const a = compile([constitutionBundle('r')]);
    const b = compile([constitutionBundle('r'), skillBundle('orders', 'S')]);
    expect(diagnoseBreak(a, b).some((x) => x.change === 'added' && x.bundleId === 'skill:orders')).toBe(true);
  });
  it('detects a removed cacheable bundle', () => {
    const a = compile([constitutionBundle('r'), policyBundle('P')]);
    const b = compile([constitutionBundle('r')]);
    expect(diagnoseBreak(a, b).some((x) => x.change === 'removed' && x.bundleId === 'policy')).toBe(true);
  });
});
