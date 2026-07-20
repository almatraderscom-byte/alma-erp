/**
 * Compensation and saga actions (G14 / SPEC-138).
 *
 * A durable workflow has no distributed transaction — it uses the saga pattern:
 * if it fails after some side-effecting steps already COMMITTED, those effects
 * are undone by running each step's compensating action, in REVERSE completion
 * order. This module deterministically plans that compensation from the template
 * (which step compensates which) and the instance state (which steps actually
 * committed a side effect).
 *
 * Pure, deterministic (INV-01). Only committed side-effecting steps with a
 * declared compensator are compensated — read-only or un-run steps are skipped.
 */
import type { WorkflowTemplate } from './registry';
import type { WorkflowInstanceState } from './state';

export interface CompensationAction {
  /** The completed step whose effect is being undone. */
  forStepId: string;
  /** The compensating step id (its `compensates` === forStepId). */
  compensateStepId: string;
  /** The gateway action the compensation runs. */
  action: string;
}

/**
 * Plan the compensation actions for a failing instance: for each COMPLETED,
 * side-effecting step that has a compensator declared in the template, emit an
 * action — ordered REVERSE of completion (undo most-recent first).
 */
export function planCompensation(
  template: WorkflowTemplate,
  state: WorkflowInstanceState,
): CompensationAction[] {
  // Map: compensated-step-id → the compensating step def.
  const compensatorFor = new Map<string, { id: string; action: string }>();
  for (const s of template.steps) {
    if (s.compensates) compensatorFor.set(s.compensates, { id: s.id, action: s.action });
  }
  const sideEffectById = new Map(template.steps.map((s) => [s.id, s.sideEffect]));

  const actions: CompensationAction[] = [];
  // Walk completed steps in reverse order (by their position in the template).
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const st = state.steps[i];
    if (st.status !== 'completed') continue;
    if (!sideEffectById.get(st.stepId)) continue; // nothing external to undo
    const comp = compensatorFor.get(st.stepId);
    if (!comp) continue; // no declared compensator → cannot auto-undo (left for dead-letter)
    actions.push({ forStepId: st.stepId, compensateStepId: comp.id, action: comp.action });
  }
  return actions;
}

/** Completed side-effecting steps that have NO compensator (need manual recovery). */
export function uncompensatableSteps(
  template: WorkflowTemplate,
  state: WorkflowInstanceState,
): string[] {
  const hasComp = new Set(template.steps.filter((s) => s.compensates).map((s) => s.compensates as string));
  const sideEffectById = new Map(template.steps.map((s) => [s.id, s.sideEffect]));
  return state.steps
    .filter((st) => st.status === 'completed' && sideEffectById.get(st.stepId) && !hasComp.has(st.stepId))
    .map((st) => st.stepId);
}
