import { describe, it, expect } from 'vitest';
import { FINANCE_TEMPLATES, financeRegistry, validateFinanceTemplates, allMoneyStepsReconcile, FINANCE_CREATE_INVOICE } from '../finance';

describe('finance workflow templates (SPEC-175)', () => {
  it('every template is structurally valid', () => {
    expect(validateFinanceTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers and resolves', () => {
    expect(financeRegistry().get('finance.create_invoice')?.version).toBe(1);
    expect(financeRegistry().get('finance.process_refund')).not.toBeNull();
  });
  it('every money-moving step is reconcile-classified (INV-06)', () => {
    expect(allMoneyStepsReconcile()).toBe(true);
  });
  it('the recorded invoice has a void compensator', () => {
    expect(FINANCE_CREATE_INVOICE.steps.find((s) => s.compensates === 'record')?.id).toBe('void');
  });
  it('drafting/validation are side-effect-free', () => {
    expect(FINANCE_TEMPLATES.flatMap((t) => t.steps).filter((s) => s.action.startsWith('specialist.')).every((s) => !s.sideEffect)).toBe(true);
  });
});
