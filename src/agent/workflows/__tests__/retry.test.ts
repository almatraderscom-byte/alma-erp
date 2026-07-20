import { describe, it, expect } from 'vitest';
import { classifyFailure, backoffFor, RETRY_REASON_CODES, type RetryInput } from '../retry';

const base: RetryInput = { failureKind: 'transient', sideEffect: false, attempts: 1, maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 10_000 };

describe('backoffFor (SPEC-135)', () => {
  it('is deterministic exponential, capped', () => {
    expect(backoffFor(1, 100, 10_000)).toBe(100);
    expect(backoffFor(2, 100, 10_000)).toBe(200);
    expect(backoffFor(3, 100, 10_000)).toBe(400);
    expect(backoffFor(10, 100, 10_000)).toBe(10_000); // capped
  });
});

describe('classifyFailure (SPEC-135)', () => {
  it('RECONCILEs an unknown side-effect outcome (INV-06, never blind retry)', () => {
    const r = classifyFailure({ ...base, failureKind: 'unknown', sideEffect: true });
    expect(r.action).toBe('RECONCILE');
    if (r.action === 'RECONCILE') expect(r.reasonCode).toBe(RETRY_REASON_CODES.UNKNOWN_SIDE_EFFECT);
  });
  it('RETRIES an unknown outcome with NO side effect (safe)', () => {
    expect(classifyFailure({ ...base, failureKind: 'unknown', sideEffect: false }).action).toBe('RETRY');
  });
  it('TERMINATES a permanent failure', () => {
    const r = classifyFailure({ ...base, failureKind: 'permanent' });
    expect(r.action).toBe('TERMINAL');
    if (r.action === 'TERMINAL') expect(r.reasonCode).toBe(RETRY_REASON_CODES.PERMANENT);
  });
  it('RETRIES a transient failure within budget, with backoff', () => {
    const r = classifyFailure({ ...base, attempts: 1 });
    expect(r.action).toBe('RETRY');
    if (r.action === 'RETRY') { expect(r.attempt).toBe(2); expect(r.backoffMs).toBe(200); }
  });
  it('TERMINATES once the attempt budget is exhausted', () => {
    const r = classifyFailure({ ...base, attempts: 3, maxAttempts: 3 });
    expect(r.action).toBe('TERMINAL');
    if (r.action === 'TERMINAL') expect(r.reasonCode).toBe(RETRY_REASON_CODES.EXHAUSTED);
  });
  it('a permanent side-effect failure is terminal, not reconcile', () => {
    expect(classifyFailure({ ...base, failureKind: 'permanent', sideEffect: true }).action).toBe('TERMINAL');
  });
  it('malformed input is TERMINAL (never a blind retry)', () => {
    const r = classifyFailure({ ...base, attempts: 0 });
    expect(r.action).toBe('TERMINAL');
    if (r.action === 'TERMINAL') expect(r.reasonCode).toBe(RETRY_REASON_CODES.MALFORMED);
  });
});
