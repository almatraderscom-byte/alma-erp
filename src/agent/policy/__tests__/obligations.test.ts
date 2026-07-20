import { describe, it, expect } from 'vitest';
import {
  parseObligation, maskValue, applyObligations, obligation, REDACTED, MAX_OBLIGATIONS,
} from '../obligations';
import { PolicyEngine, type PolicyEvaluationInput, type PolicyLayer } from '../decision';
import { humanPrincipal } from '@/agent/identity/principals';

describe('parseObligation (SPEC-109)', () => {
  it('parses each canonical kind', () => {
    expect(parseObligation('audit')).toEqual({ kind: 'audit', raw: 'audit' });
    expect(parseObligation('deny_export')).toEqual({ kind: 'deny_export', raw: 'deny_export' });
    expect(parseObligation('redact:a.b')).toEqual({ kind: 'redact', target: 'a.b', raw: 'redact:a.b' });
    expect(parseObligation('mask:phone')).toEqual({ kind: 'mask', target: 'phone', keepLast: 4, raw: 'mask:phone' });
    expect(parseObligation('mask:phone:2')).toEqual({ kind: 'mask', target: 'phone', keepLast: 2, raw: 'mask:phone:2' });
  });
  it('rejects malformed strings', () => {
    expect(parseObligation('redact')).toBeNull();
    expect(parseObligation('audit:x')).toBeNull();
    expect(parseObligation('mask:phone:-1')).toBeNull();
    expect(parseObligation('mask:phone:x')).toBeNull();
    expect(parseObligation('bogus:y')).toBeNull();
  });
});

describe('maskValue (SPEC-109)', () => {
  it('keeps the last N chars, masks the rest', () => {
    expect(maskValue('01712345678', 4)).toBe('*******5678');
    expect(maskValue('abcd', 4)).toBe('abcd'); // keepLast >= length → unchanged
    expect(maskValue('abcd', 0)).toBe('****');
  });
  it('fully redacts a non-string secret', () => {
    expect(maskValue(12345, 2)).toBe(REDACTED);
    expect(maskValue({ a: 1 }, 2)).toBe(REDACTED);
  });
});

describe('applyObligations (SPEC-109)', () => {
  const payload = () => ({
    name: 'ACME',
    customer: { phone: '01712345678', ssn: '123-45-6789' },
    total: 5000,
  });

  it('redacts and masks nested paths without mutating the input', () => {
    const input = payload();
    const r = applyObligations(input, [obligation.redact('customer.ssn'), obligation.mask('customer.phone', 4)]);
    expect(r.value.customer.ssn).toBe(REDACTED);
    expect(r.value.customer.phone).toBe('*******5678');
    expect(r.applied).toHaveLength(2);
    // input untouched (deep clone)
    expect(input.customer.ssn).toBe('123-45-6789');
    expect(input.customer.phone).toBe('01712345678');
  });

  it('flags audit and deny_export without changing data', () => {
    const r = applyObligations(payload(), ['audit', 'deny_export']);
    expect(r.auditRequired).toBe(true);
    expect(r.denyExport).toBe(true);
    expect(r.value.total).toBe(5000);
  });

  it('reports malformed obligations instead of silently applying them', () => {
    const r = applyObligations(payload(), ['redact', 'bogus:x', obligation.redact('name')]);
    expect(r.malformed).toEqual(['redact', 'bogus:x']);
    expect(r.value.name).toBe(REDACTED);
    expect(r.applied).toHaveLength(1);
  });

  it('a redact for a missing path is a no-op (not counted as applied)', () => {
    const r = applyObligations(payload(), [obligation.redact('customer.missing')]);
    expect(r.applied).toHaveLength(0);
    expect(r.malformed).toHaveLength(0);
  });

  it('bounds the number of obligations processed', () => {
    const many = Array.from({ length: MAX_OBLIGATIONS + 10 }, () => 'audit');
    const r = applyObligations(payload(), many);
    expect(r.applied.length).toBeLessThanOrEqual(MAX_OBLIGATIONS);
  });
});

describe('obligations end-to-end with the engine (SPEC-105 + SPEC-109)', () => {
  const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
  const permitWithObligation: PolicyLayer = {
    name: 'rbac',
    evaluate: (): { layer: string; effect: 'permit'; reasonCodes: string[]; obligations: string[] } => ({
      layer: 'rbac', effect: 'permit', reasonCodes: [], obligations: [obligation.mask('customer.phone', 4), 'audit'],
    }),
  };

  it('carries obligations from the permit through to redaction', () => {
    const input: PolicyEvaluationInput = {
      identity,
      principal: humanPrincipal(identity, ['staff']),
      action: 'orders.read',
      resource: { type: 'order', id: 'o-1', tenantId: 'alma' },
    };
    const decision = new PolicyEngine([permitWithObligation]).decide(input);
    expect(decision.status).toBe('ALLOWED');
    if (decision.status === 'ALLOWED') {
      const view = applyObligations({ customer: { phone: '01712345678' } }, decision.value.obligations);
      expect(view.value.customer.phone).toBe('*******5678');
      expect(view.auditRequired).toBe(true);
    }
  });
});
