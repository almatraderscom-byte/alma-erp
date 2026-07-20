import { describe, it, expect } from 'vitest';
import { CUSTOMER_SUPPORT_TEMPLATES, customerSupportRegistry, validateCustomerSupportTemplates, CS_ANSWER_INQUIRY } from '../customer-support';

describe('customer-support workflow templates (SPEC-174)', () => {
  it('every template is structurally valid', () => {
    expect(validateCustomerSupportTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers and resolves', () => {
    expect(customerSupportRegistry().get('cs.answer_inquiry')?.version).toBe(1);
  });
  it('the outbound send is a reconcilable side effect', () => {
    const send = CS_ANSWER_INQUIRY.steps.find((s) => s.id === 'send')!;
    expect(send.sideEffect).toBe(true);
    expect(send.onFailure).toBe('reconcile');
  });
  it('classification and drafting have no external side effect', () => {
    expect(CS_ANSWER_INQUIRY.steps.filter((s) => s.id !== 'send').every((s) => !s.sideEffect)).toBe(true);
  });
  it('exposes multiple templates', () => {
    expect(CUSTOMER_SUPPORT_TEMPLATES.length).toBeGreaterThanOrEqual(2);
  });
});
