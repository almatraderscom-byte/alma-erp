/**
 * Known-workflow no-planner evaluation (G18 / SPEC-180).
 *
 * The point of "known workflows" is that routine business tasks run WITHOUT the
 * expensive planner/head — a fixed template is executed deterministically. This
 * gate proves that property across every domain template: each is a valid G14
 * template, every step is a CONCRETE action (never a plan/head step), ids are
 * unique across domains, and each template can be driven to `completed` by the
 * pure G14 state reducer with no planning decision anywhere.
 *
 * Deterministic, executable proof (INV-01, INV-10).
 */
import { workflowTemplateRegistry, validateTemplate, type WorkflowTemplate } from '@/agent/workflows/registry';
import { initialState, applyEvent, type WorkflowInstanceState } from '@/agent/workflows/state';
import { MARKETING_TEMPLATES } from './marketing';
import { CUSTOMER_SUPPORT_TEMPLATES } from './customer-support';
import { FINANCE_TEMPLATES } from './finance';
import { ERP_OFFICE_TEMPLATES } from './erp-office';
import { RESEARCH_TEMPLATES } from './research';
import { EXTERNAL_COMMS_TEMPLATES } from './external-comms';

/** Every known-workflow template across all domains. */
export const ALL_KNOWN_TEMPLATES: WorkflowTemplate[] = [
  ...MARKETING_TEMPLATES,
  ...CUSTOMER_SUPPORT_TEMPLATES,
  ...FINANCE_TEMPLATES,
  ...ERP_OFFICE_TEMPLATES,
  ...RESEARCH_TEMPLATES,
  ...EXTERNAL_COMMS_TEMPLATES,
];

/** Actions that would imply a planner/head is needed (forbidden in known workflows). */
const PLANNER_ACTION_PATTERNS = [/^plan\./, /^head\./, /\.plan$/, /planner/i];

/** Does a template need a planner? (any step whose action looks like planning). */
export function needsPlanner(template: WorkflowTemplate): boolean {
  return template.steps.some((s) => PLANNER_ACTION_PATTERNS.some((re) => re.test(s.action)));
}

/**
 * Drive a template's FORWARD (non-compensating) steps through the pure reducer —
 * no planner involved. Compensator steps (those with `compensates`) run only on
 * rollback (SPEC-138), never in the happy path, so success is: every forward step
 * sequences deterministically to `completed`. This holds when compensators sit at
 * the trailing indices (the convention these templates follow).
 */
function runsToCompletionWithoutPlanner(template: WorkflowTemplate): boolean {
  const identity = { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' };
  let state: WorkflowInstanceState = initialState(template, { templateId: template.id, templateVersion: template.version }, identity, 'inst', 0);
  let t = 1;
  const forward = template.steps.filter((s) => !s.compensates);
  for (const step of forward) {
    const started = applyEvent(state, { type: 'STEP_STARTED', stepId: step.id, atMs: t++ });
    if (!started.ok) return false;
    state = started.state;
    const done = applyEvent(state, { type: 'STEP_COMPLETED', stepId: step.id, atMs: t++ });
    if (!done.ok) return false;
    state = done.state;
  }
  // Every forward step reached `completed` with no planning decision anywhere.
  const forwardIds = new Set(forward.map((s) => s.id));
  return state.steps.filter((s) => forwardIds.has(s.stepId)).every((s) => s.status === 'completed');
}

export interface KnownWorkflowCertification {
  ok: boolean;
  total: number;
  failures: string[];
}

/** Certify every known workflow: valid, planner-free, unique-id, deterministically runnable. */
export function certifyKnownWorkflows(): KnownWorkflowCertification {
  const failures: string[] = [];
  const seen = new Set<string>();

  for (const t of ALL_KNOWN_TEMPLATES) {
    const key = `${t.id}@${t.version}`;
    if (seen.has(key)) failures.push(`duplicate template id ${key}`);
    seen.add(key);

    const v = validateTemplate(t);
    if (!v.ok) failures.push(`${key}: invalid — ${v.errors[0]}`);
    if (needsPlanner(t)) failures.push(`${key}: contains a planner/head step`);
    if (!runsToCompletionWithoutPlanner(t)) failures.push(`${key}: does not run to completion without a planner`);
  }

  // The combined registry must also build (unique keys, all valid).
  try {
    workflowTemplateRegistry(ALL_KNOWN_TEMPLATES);
  } catch (e) {
    failures.push(`combined registry rejected: ${(e as Error).message}`);
  }

  return { ok: failures.length === 0, total: ALL_KNOWN_TEMPLATES.length, failures };
}
