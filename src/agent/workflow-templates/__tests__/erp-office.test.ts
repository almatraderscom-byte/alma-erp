import { describe, it, expect } from 'vitest';
import { ERP_OFFICE_TEMPLATES, erpOfficeRegistry, validateErpOfficeTemplates, ERP_CREATE_ORDER, ERP_GENERATE_REPORT } from '../erp-office';

describe('erp-office workflow templates (SPEC-176)', () => {
  it('every template is structurally valid', () => {
    expect(validateErpOfficeTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers all three', () => {
    const reg = erpOfficeRegistry();
    expect(reg.get('erp.create_order')).not.toBeNull();
    expect(reg.get('erp.adjust_inventory')).not.toBeNull();
    expect(reg.get('erp.generate_report')).not.toBeNull();
  });
  it('create_order has a cancel compensator on the write', () => {
    expect(ERP_CREATE_ORDER.steps.find((s) => s.compensates === 'create')?.id).toBe('cancel');
  });
  it('report generation is entirely read-only', () => {
    expect(ERP_GENERATE_REPORT.steps.every((s) => !s.sideEffect)).toBe(true);
  });
});
