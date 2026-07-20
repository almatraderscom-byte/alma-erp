import { describe, it, expect } from 'vitest';
import { constitutionBundle, workflowStateBundle } from '../../prompts/bundles';
import { compile } from '../compiler';

describe('workflowStateBundle (SPEC-045)', () => {
  it('is a dynamic (non-cacheable) workflow_state bundle', () => {
    const b = workflowStateBundle({ step: 'pay', status: 'pending' });
    expect(b.kind).toBe('workflow_state');
    expect(b.cacheable).toBe(false);
  });
  it('serialises state deterministically (sorted keys)', () => {
    const a = workflowStateBundle({ b: 2, a: 1 });
    const c = workflowStateBundle({ a: 1, b: 2 });
    expect(a.content).toBe(c.content);
  });
  it('breaks the cacheable prefix (dynamic comes after the stable prefix)', () => {
    const compiled = compile([constitutionBundle(), workflowStateBundle({ x: 1 })]);
    expect(compiled.cacheablePrefixTokens).toBeLessThan(compiled.totalTokens);
    expect(compiled.provenance.map((p) => p.kind)).toEqual(['constitution', 'workflow_state']);
  });
});
