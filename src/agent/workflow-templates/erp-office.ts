/**
 * ERP and office workflow templates (G18 / SPEC-176).
 *
 * Known back-office workflows that touch the ERP through the tool gateway —
 * create an order, adjust inventory, produce a report. Write steps are
 * reconcilable side effects; report generation is read-only. Pure G14
 * WorkflowTemplates, validated against the registry. Deterministic (INV-01).
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

export const ERP_CREATE_ORDER: WorkflowTemplate = {
  id: 'erp.create_order',
  version: 1,
  description: 'Validate an order, create it, and confirm.',
  steps: [
    { id: 'validate', action: 'specialist.ops.validate_order', sideEffect: false, onFailure: 'retryable' },
    { id: 'create', action: 'order.create', sideEffect: true, onFailure: 'reconcile' },
    { id: 'cancel', action: 'order.cancel', sideEffect: true, onFailure: 'terminal', compensates: 'create' },
  ],
};

export const ERP_ADJUST_INVENTORY: WorkflowTemplate = {
  id: 'erp.adjust_inventory',
  version: 1,
  description: 'Apply a reconcilable inventory adjustment.',
  steps: [
    { id: 'check', action: 'inventory.check', sideEffect: false, onFailure: 'retryable' },
    { id: 'adjust', action: 'inventory.adjust', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const ERP_GENERATE_REPORT: WorkflowTemplate = {
  id: 'erp.generate_report',
  version: 1,
  description: 'Pull figures and summarise a report (read-only).',
  steps: [
    { id: 'pull', action: 'report.pull', sideEffect: false, onFailure: 'retryable' },
    { id: 'summarize', action: 'specialist.ops.summarize', sideEffect: false, onFailure: 'retryable' },
  ],
};

export const ERP_OFFICE_TEMPLATES: WorkflowTemplate[] = [ERP_CREATE_ORDER, ERP_ADJUST_INVENTORY, ERP_GENERATE_REPORT];

export function erpOfficeRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(ERP_OFFICE_TEMPLATES);
}

export function validateErpOfficeTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of ERP_OFFICE_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}
