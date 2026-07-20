import { describe, it, expect } from 'vitest';
import { idempotencyKey, resolveIdempotency, IDEMPOTENCY_REASON_CODES, type IdempotencyRecord } from '../idempotency';

const pin = { templateId: 'wf', templateVersion: 2 };

describe('idempotencyKey (SPEC-136)', () => {
  it('is stable for the same (instance, step, pin) across attempts', () => {
    const a = idempotencyKey('inst-1', 'stepA', pin);
    const b = idempotencyKey('inst-1', 'stepA', pin);
    expect(a).toBe(b);
    expect(a.startsWith('idem_')).toBe(true);
  });
  it('differs by instance, step, and template version', () => {
    const k = idempotencyKey('inst-1', 'stepA', pin);
    expect(idempotencyKey('inst-2', 'stepA', pin)).not.toBe(k);
    expect(idempotencyKey('inst-1', 'stepB', pin)).not.toBe(k);
    expect(idempotencyKey('inst-1', 'stepA', { templateId: 'wf', templateVersion: 3 })).not.toBe(k);
  });
});

describe('resolveIdempotency (SPEC-136)', () => {
  const key = idempotencyKey('inst-1', 'stepA', pin);
  it('PROCEEDs when there is no record', () => {
    expect(resolveIdempotency(key, null).action).toBe('PROCEED');
  });
  it('SKIPs a committed effect and returns its result ref', () => {
    const rec: IdempotencyRecord = { key, status: 'committed', resultRef: 'ev-9' };
    const d = resolveIdempotency(key, rec);
    expect(d.action).toBe('SKIP');
    if (d.action === 'SKIP') expect(d.resultRef).toBe('ev-9');
  });
  it('RECONCILEs an in-flight record (never re-runs a side effect)', () => {
    const d = resolveIdempotency(key, { key, status: 'in_flight' });
    expect(d.action).toBe('RECONCILE');
    if (d.action === 'RECONCILE') expect(d.reasonCode).toBe(IDEMPOTENCY_REASON_CODES.IN_FLIGHT);
  });
  it('RECONCILEs an unknown outcome (INV-06)', () => {
    const d = resolveIdempotency(key, { key, status: 'unknown' });
    expect(d.action).toBe('RECONCILE');
    if (d.action === 'RECONCILE') expect(d.reasonCode).toBe(IDEMPOTENCY_REASON_CODES.UNKNOWN);
  });
  it('RECONCILEs on a key mismatch (never skips on a foreign record)', () => {
    const d = resolveIdempotency(key, { key: 'idem_other', status: 'committed', resultRef: 'x' });
    expect(d.action).toBe('RECONCILE');
    if (d.action === 'RECONCILE') expect(d.reasonCode).toBe(IDEMPOTENCY_REASON_CODES.KEY_MISMATCH);
  });
});
