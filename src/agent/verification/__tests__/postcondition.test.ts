import { describe, it, expect } from 'vitest';
import { verifyPostcondition, evalCheck, resolvePath, POSTCONDITION_REASON_CODES, type Postcondition } from '../postcondition';

const observed = { status: 'published', postId: 'p-9', count: 5, tags: ['a'] };

describe('resolvePath / evalCheck (SPEC-181)', () => {
  it('resolves nested paths', () => {
    expect(resolvePath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(resolvePath({ a: {} }, 'a.b.c')).toBeUndefined();
  });
  it('evaluates each op', () => {
    expect(evalCheck(observed, { path: 'postId', op: 'exists' })).toBe(true);
    expect(evalCheck(observed, { path: 'missing', op: 'exists' })).toBe(false);
    expect(evalCheck(observed, { path: 'status', op: 'eq', value: 'published' })).toBe(true);
    expect(evalCheck(observed, { path: 'count', op: 'gte', value: 5 })).toBe(true);
    expect(evalCheck(observed, { path: 'tags', op: 'nonempty' })).toBe(true);
    expect(evalCheck(observed, { path: 'count', op: 'lt', value: 3 })).toBe(false);
  });
});

describe('verifyPostcondition (SPEC-181)', () => {
  it('COMPLETED when all checks hold', () => {
    const post: Postcondition = { id: 'published', checks: [
      { path: 'status', op: 'eq', value: 'published' },
      { path: 'postId', op: 'nonempty' },
    ] };
    expect(verifyPostcondition(post, observed).status).toBe('COMPLETED');
  });
  it('FAILED_FINAL listing the failed checks', () => {
    const post: Postcondition = { id: 'p', checks: [{ path: 'status', op: 'eq', value: 'live' }] };
    const r = verifyPostcondition(post, observed);
    expect(r.status).toBe('FAILED_FINAL');
    if (r.status === 'FAILED_FINAL') expect(r.reasonCodes).toContain(POSTCONDITION_REASON_CODES.FAILED);
  });
  it('FAILED_FINAL (malformed) fails closed, never passes', () => {
    expect(verifyPostcondition({ id: '', checks: [] } as unknown as Postcondition, observed).status).toBe('FAILED_FINAL');
  });
});
