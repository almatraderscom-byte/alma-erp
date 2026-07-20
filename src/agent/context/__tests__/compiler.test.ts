import { describe, it, expect } from 'vitest';
import { BUNDLE_ORDER, CONTEXT_CONTRACT_VERSION, compile, type ContextBundle } from '../compiler';

const bundle = (over: Partial<ContextBundle> & Pick<ContextBundle, 'id' | 'kind'>): ContextBundle => ({
  content: 'x', cacheable: false, ...over,
});

describe('compile (SPEC-041)', () => {
  it('orders bundles by their fixed kind order regardless of input order', () => {
    const c = compile([
      bundle({ id: 'r', kind: 'request_suffix', content: 'REQ' }),
      bundle({ id: 'c', kind: 'constitution', content: 'CONST', cacheable: true }),
      bundle({ id: 'm', kind: 'memory', content: 'MEM' }),
    ]);
    expect(c.text).toBe('CONST\n\nMEM\n\nREQ');
    expect(c.provenance.map((p) => p.kind)).toEqual(['constitution', 'memory', 'request_suffix']);
  });

  it('is deterministic (same bundles → same text + tokens)', () => {
    const bs = [bundle({ id: 'c', kind: 'constitution', content: 'hello world', cacheable: true })];
    expect(compile(bs).text).toBe(compile(bs).text);
    expect(compile(bs).totalTokens).toBe(compile(bs).totalTokens);
  });

  it('counts total tokens as the sum of bundle tokens', () => {
    const c = compile([
      bundle({ id: 'a', kind: 'constitution', content: '12345678', cacheable: true }), // 2
      bundle({ id: 'b', kind: 'request_suffix', content: '1234' }), // 1
    ]);
    expect(c.totalTokens).toBe(c.provenance.reduce((s, p) => s + p.tokens, 0));
    expect(c.totalTokens).toBeGreaterThan(0);
  });

  it('cacheablePrefixTokens counts only the leading cacheable run', () => {
    const c = compile([
      bundle({ id: 'c', kind: 'constitution', content: 'aaaaaaaa', cacheable: true }),
      bundle({ id: 's', kind: 'skill', content: 'bbbbbbbb', cacheable: true }),
      bundle({ id: 'm', kind: 'memory', content: 'cccccccc', cacheable: false }), // breaks the run
    ]);
    // constitution + skill cacheable; memory not -> prefix stops before memory
    expect(c.cacheablePrefixTokens).toBe(c.provenance[0].tokens + c.provenance[1].tokens);
    expect(c.cacheablePrefixTokens).toBeLessThan(c.totalTokens);
  });

  it('records provenance with version + contract version', () => {
    const c = compile([bundle({ id: 'c', kind: 'constitution', cacheable: true, version: '3' })]);
    expect(c.provenance[0].version).toBe('3');
    expect(c.contractVersion).toBe(CONTEXT_CONTRACT_VERSION);
  });

  it('freezes the canonical bundle order', () => {
    expect(BUNDLE_ORDER.constitution).toBeLessThan(BUNDLE_ORDER.skill);
    expect(BUNDLE_ORDER.tool_schema).toBeLessThan(BUNDLE_ORDER.request_suffix);
  });
});
