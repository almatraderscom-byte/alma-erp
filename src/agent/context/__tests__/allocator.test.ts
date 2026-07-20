import { describe, it, expect } from 'vitest';
import { MUST_KEEP, TRUNCATE_PRIORITY, allocate } from '../allocator';
import { constitutionBundle, memoryBundle, policyBundle, requestSuffixBundle, workflowStateBundle } from '../../prompts/bundles';

const big = (n: number) => 'x'.repeat(n);

describe('allocate (SPEC-049)', () => {
  it('FIT: keeps everything when under budget', () => {
    const r = allocate([constitutionBundle('short'), requestSuffixBundle('hi')], 1000);
    expect(r.status).toBe('FIT');
    expect(r.droppedKinds).toEqual([]);
  });

  it('TRUNCATED: drops memory first to fit', () => {
    const bundles = [
      constitutionBundle('cccc'),
      requestSuffixBundle('qqqq'),
      memoryBundle([big(4000)]), // ~1000 tokens
    ];
    const r = allocate(bundles, 20);
    expect(r.status).toBe('TRUNCATED');
    expect(r.droppedKinds).toContain('memory');
    expect(r.compiled.totalTokens).toBeLessThanOrEqual(20);
  });

  it('drops in priority order: memory before workflow_state', () => {
    const bundles = [
      constitutionBundle('c'),
      requestSuffixBundle('q'),
      workflowStateBundle({ data: big(400) }),
      memoryBundle([big(400)]),
    ];
    const r = allocate(bundles, 30);
    // memory dropped first; workflow_state only if still over
    expect(r.droppedKinds[0]).toBe('memory');
  });

  it('never drops a must-keep bundle', () => {
    const bundles = [constitutionBundle(big(4000)), requestSuffixBundle('q')];
    const r = allocate(bundles, 10);
    expect(r.droppedKinds.every((k) => !MUST_KEEP.includes(k))).toBe(true);
  });

  it('OVERFLOW (fail-closed) when must-keeps alone exceed the budget', () => {
    const r = allocate([constitutionBundle(big(8000)), requestSuffixBundle(big(8000))], 10);
    expect(r.status).toBe('OVERFLOW');
  });

  it('truncate priority excludes every must-keep kind', () => {
    for (const k of MUST_KEEP) expect(TRUNCATE_PRIORITY).not.toContain(k);
  });
});
