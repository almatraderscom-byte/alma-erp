/**
 * Research workflow templates (G18 / SPEC-177).
 *
 * Known research workflows: gather sources, synthesize, and produce a cited
 * summary. Entirely read-only — no external side effects — but still routed
 * through the gateway (for cost + evidence) and bounded. Pure G14
 * WorkflowTemplates, validated against the registry. Deterministic (INV-01).
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate, type WorkflowTemplateRegistry } from '@/agent/workflows/registry';

export const RESEARCH_MARKET_SCAN: WorkflowTemplate = {
  id: 'research.market_scan',
  version: 1,
  description: 'Gather sources, synthesize, and produce a cited summary.',
  steps: [
    { id: 'gather', action: 'search.query', sideEffect: false, onFailure: 'retryable' },
    { id: 'read', action: 'browser.read', sideEffect: false, onFailure: 'retryable' },
    { id: 'synthesize', action: 'specialist.research.synthesize', sideEffect: false, onFailure: 'retryable' },
    { id: 'cite', action: 'specialist.research.cite', sideEffect: false, onFailure: 'retryable' },
  ],
};

export const RESEARCH_TEMPLATES: WorkflowTemplate[] = [RESEARCH_MARKET_SCAN];

export function researchRegistry(): WorkflowTemplateRegistry {
  return workflowTemplateRegistry(RESEARCH_TEMPLATES);
}

export function validateResearchTemplates(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const t of RESEARCH_TEMPLATES) {
    const r = validateTemplate(t);
    if (!r.ok) errors.push(`${t.id}@${t.version}: ${r.errors[0]}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Research is read-only: no template has a side-effecting step. */
export function researchIsReadOnly(): boolean {
  return RESEARCH_TEMPLATES.every((t) => t.steps.every((s) => !s.sideEffect));
}
