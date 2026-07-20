/**
 * Finance and invoice workflow templates (G18 / SPEC-175).
 *
 * Known finance workflows — the highest-stakes domain. Each money-moving step is a
 * side effect classified `reconcile` (INV-06) and, where reversible, carries a
 * compensator; at runtime these steps also hit the G12 financial approval rule
 * (over-ceiling / payroll ⇒ owner approval) and the G04 cost governor. Pure G14
 * WorkflowTemplates, validated against the registry.
 *
 * Deterministic data + validation (INV-01). Money is USD nano at runtime — never
 * encoded in the template.
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

export const FINANCE_CREATE_INVOICE: WorkflowTemplate = {
  id: 'finance.create_invoice',
  version: 1,
  description: 'Draft an invoice, record it, and send it to the customer.',
  steps: [
    { id: 'draft', action: 'specialist.finance.draft_invoice', sideEffect: false, onFailure: 'retryable' },
    { id: 'record', action: 'invoice.record', sideEffect: true, onFailure: 'reconcile' },
    { id: 'send', action: 'invoice.send', sideEffect: true, onFailure: 'reconcile' },
    { id: 'void', action: 'invoice.void', sideEffect: true, onFailure: 'terminal', compensates: 'record' },
  ],
};

export const FINANCE_PROCESS_REFUND: WorkflowTemplate = {
  id: 'finance.process_refund',
  version: 1,
  description: 'Validate and issue a refund (approval-gated, reconcilable).',
  steps: [
    { id: 'validate', action: 'specialist.finance.validate_refund', sideEffect: false, onFailure: 'retryable' },
    { id: 'refund', action: 'wallet.refund', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const FINANCE_TEMPLATES: WorkflowTemplate[] = [FINANCE_CREATE_INVOICE, FINANCE_PROCESS_REFUND];

export function financeRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(FINANCE_TEMPLATES);
}

export function validateFinanceTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of FINANCE_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Every money-moving (side-effecting) finance step is reconcile-classified. */
export function allMoneyStepsReconcile(): boolean {
  return FINANCE_TEMPLATES.every((t) =>
    t.steps.filter((s) => s.sideEffect && !s.compensates).every((s) => s.onFailure === 'reconcile'),
  );
}
