/**
 * External communication workflows (G18 / SPEC-178).
 *
 * Known workflows that send messages OUTSIDE the business — email, Telegram,
 * WhatsApp broadcast. Every outbound send is a reconcilable side effect gated by
 * the G12 external-publishing approval rule and executed through the G13 gateway.
 * Pure G14 WorkflowTemplates, validated against the registry. Deterministic
 * (INV-01).
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

export const COMMS_SEND_EMAIL: WorkflowTemplate = {
  id: 'comms.send_email',
  version: 1,
  description: 'Compose an email and send it after approval.',
  steps: [
    { id: 'compose', action: 'specialist.comms.compose', sideEffect: false, onFailure: 'retryable' },
    { id: 'send', action: 'email.send', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const COMMS_BROADCAST: WorkflowTemplate = {
  id: 'comms.broadcast',
  version: 1,
  description: 'Compose and broadcast a message to a customer segment after approval.',
  steps: [
    { id: 'compose', action: 'specialist.comms.compose', sideEffect: false, onFailure: 'retryable' },
    { id: 'segment', action: 'audience.resolve', sideEffect: false, onFailure: 'retryable' },
    { id: 'broadcast', action: 'broadcast.send', sideEffect: true, onFailure: 'reconcile' },
  ],
};

export const EXTERNAL_COMMS_TEMPLATES: WorkflowTemplate[] = [COMMS_SEND_EMAIL, COMMS_BROADCAST];

export function externalCommsRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(EXTERNAL_COMMS_TEMPLATES);
}

export function validateExternalCommsTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of EXTERNAL_COMMS_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Every outbound send is a reconcilable side effect (approval-gated at runtime). */
export function allSendsReconcile(): boolean {
  return EXTERNAL_COMMS_TEMPLATES.every((t) =>
    t.steps.filter((s) => s.sideEffect).every((s) => s.onFailure === 'reconcile'),
  );
}
