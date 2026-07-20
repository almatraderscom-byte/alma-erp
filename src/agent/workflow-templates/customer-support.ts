/**
 * Customer-support workflow templates (G18 / SPEC-174).
 *
 * Known CS workflows: answer a customer inquiry (classify → draft a Bangla reply
 * with the CS specialist → gate the outbound message behind approval → send), and
 * escalate to the owner. Pure G14 WorkflowTemplates, validated against the
 * registry. Customer-facing sends are side effects that go through approval (G12)
 * and the gateway (G13) at runtime.
 *
 * Deterministic data + validation (INV-01).
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

export const CS_ANSWER_INQUIRY: WorkflowTemplate = {
  id: 'cs.answer_inquiry',
  version: 1,
  description: 'Classify a customer message, draft a reply, send after approval.',
  steps: [
    { id: 'classify', action: 'specialist.cs.classify', sideEffect: false, onFailure: 'retryable' },
    { id: 'draft', action: 'specialist.cs.draft_reply', sideEffect: false, onFailure: 'retryable' },
    { id: 'send', action: 'message.send', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const CS_ESCALATE: WorkflowTemplate = {
  id: 'cs.escalate',
  version: 1,
  description: 'Summarize an unresolved case and notify the owner.',
  steps: [
    { id: 'summarize', action: 'specialist.cs.summarize', sideEffect: false, onFailure: 'retryable' },
    { id: 'notify_owner', action: 'owner.notify', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const CUSTOMER_SUPPORT_TEMPLATES: WorkflowTemplate[] = [CS_ANSWER_INQUIRY, CS_ESCALATE];

export function customerSupportRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(CUSTOMER_SUPPORT_TEMPLATES);
}

export function validateCustomerSupportTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of CUSTOMER_SUPPORT_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}
