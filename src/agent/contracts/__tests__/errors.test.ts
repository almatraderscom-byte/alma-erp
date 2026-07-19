import { describe, it, expect } from 'vitest';
import { REASON_CODES } from '../component';
import {
  AiosError,
  ERROR_TAXONOMY,
  isRetryable,
  normalizeError,
  toComponentFailure,
  type ErrorCategory,
} from '../errors';

describe('ERROR_TAXONOMY', () => {
  it('covers every category with a status + reason + retry flag', () => {
    for (const [cat, spec] of Object.entries(ERROR_TAXONOMY)) {
      expect(spec.status).toBeTruthy();
      expect(spec.reasonCode).toBeTruthy();
      expect(typeof spec.retryable).toBe('boolean');
      expect(cat).toBeTruthy();
    }
  });

  it('marks only timeout + retryable-dependency as retryable', () => {
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('DEPENDENCY_RETRYABLE')).toBe(true);
    expect(isRetryable('DEPENDENCY_FINAL')).toBe(false);
    expect(isRetryable('POLICY')).toBe(false);
    expect(isRetryable('UNKNOWN_OUTCOME')).toBe(false);
  });
});

describe('toComponentFailure', () => {
  it('maps a budget error to BUDGET_EXCEEDED', () => {
    const f = toComponentFailure(new AiosError('BUDGET', 'over cap'));
    expect(f.status).toBe('BUDGET_EXCEEDED');
    expect(f.reasonCodes).toContain(REASON_CODES.BUDGET_EXCEEDED);
  });

  it('maps an approval error and carries the approvalRequestId', () => {
    const f = toComponentFailure(new AiosError('APPROVAL', 'need ok', { approvalRequestId: 'ap-1' }));
    expect(f.status).toBe('NEEDS_APPROVAL');
    expect(f.approvalRequestId).toBe('ap-1');
  });

  it('maps a retryable dependency error and carries retryAfterMs', () => {
    const f = toComponentFailure(new AiosError('DEPENDENCY_RETRYABLE', 'try later', { retryAfterMs: 1000 }));
    expect(f.status).toBe('RETRYABLE');
    expect(f.retryAfterMs).toBe(1000);
  });

  it('maps a tenant error to DENIED + CROSS_TENANT', () => {
    const f = toComponentFailure(new AiosError('TENANT', 'nope'));
    expect(f.status).toBe('DENIED');
    expect(f.reasonCodes).toContain(REASON_CODES.CROSS_TENANT);
  });
});

describe('normalizeError — the boundary net', () => {
  it('normalises an AiosError by category', () => {
    const f = normalizeError(new AiosError('TIMEOUT', 't'));
    expect(f.status).toBe('RETRYABLE');
  });

  it('normalises an unknown throw to INTERNAL FAILED_FINAL (never re-throws)', () => {
    const f = normalizeError(new Error('boom'));
    expect(f.status).toBe('FAILED_FINAL');
  });

  it('normalises a non-Error throw (string) safely', () => {
    const f = normalizeError('weird');
    expect(f.status).toBe('FAILED_FINAL');
    expect(Array.isArray(f.reasonCodes)).toBe(true);
  });

  it('never marks a normalised unknown outcome as retryable', () => {
    const cats: ErrorCategory[] = ['UNKNOWN_OUTCOME', 'INTERNAL'];
    for (const c of cats) expect(isRetryable(c)).toBe(false);
  });
});
