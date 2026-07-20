/**
 * Marketing workflow templates (G18 / SPEC-173).
 *
 * "Known workflows" for marketing — a fixed, ordered step sequence the runtime
 * executes WITHOUT a planner (SPEC-180). Each is a G14 WorkflowTemplate: draft via
 * a marketing specialist, gate the public step behind approval (G12), publish
 * through the tool gateway (G13), and carry a compensator to unpublish. Templates
 * are pure data, validated against the G14 registry so a malformed one never runs.
 *
 * Deterministic (INV-01): no LLM/IO here — just declarations + validation.
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

/** Publish a single marketing post (draft → publish → verify), unpublish-compensated. */
export const MARKETING_PUBLISH_POST: WorkflowTemplate = {
  id: 'marketing.publish_post',
  version: 1,
  description: 'Draft a post with the marketing specialist, publish it, verify it went live.',
  steps: [
    { id: 'draft', action: 'specialist.marketing.draft', sideEffect: false, onFailure: 'retryable' },
    { id: 'publish', action: 'facebook.publish', sideEffect: true, onFailure: 'reconcile' },
    { id: 'verify', action: 'facebook.verify', sideEffect: false, onFailure: 'retryable' },
    { id: 'unpublish', action: 'facebook.delete', sideEffect: true, onFailure: 'terminal', compensates: 'publish' },
  ],
};

/** Produce a marketing image and attach it to a draft (no external side effect). */
export const MARKETING_GENERATE_CREATIVE: WorkflowTemplate = {
  id: 'marketing.generate_creative',
  version: 1,
  description: 'Generate a product image and a caption for owner review.',
  steps: [
    { id: 'brief', action: 'specialist.marketing.brief', sideEffect: false, onFailure: 'retryable' },
    { id: 'image', action: 'image.generate', sideEffect: false, onFailure: 'retryable' },
    { id: 'caption', action: 'specialist.marketing.caption', sideEffect: false, onFailure: 'retryable' },
  ],
};

export const MARKETING_TEMPLATES: WorkflowTemplate[] = [MARKETING_PUBLISH_POST, MARKETING_GENERATE_CREATIVE];

/** All marketing templates, validated and registered. Throws on a malformed one. */
export function marketingRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(MARKETING_TEMPLATES);
}

/** Validate every marketing template (used by tests + the known-workflow gate). */
export function validateMarketingTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of MARKETING_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}
