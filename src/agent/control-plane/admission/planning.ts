/**
 * Planning-need classification (G02 / SPEC-017).
 *
 * Deterministic decision: does this request need a multi-step PLAN, or can it be
 * handled one-shot (NONE)? Feeds the planner/workflow decision downstream (G14).
 * No model (INV-01). Reads the normalized request and, if present, the
 * complexity annotation from SPEC-016.
 */
import type { AdmissionStage } from './gateway';
import type { NormalizedRequest } from './normalize';
import type { ComplexityClass } from './complexity';

export const PLANNING_NEEDS = ['NONE', 'PLAN'] as const;
export type PlanningNeed = (typeof PLANNING_NEEDS)[number];

const STEP_MARKERS = /\b(and then|after that|then|next|also|ar por|tarpor|ebong)\b/gi;
const TASK_VERBS = /\b(create|make|send|update|delete|add|remove|schedule|post|generate|pay|order|banao|pathao|toiri|koro)\b/gi;

export interface PlanningResult {
  planningNeed: PlanningNeed;
  reasons: string[];
}

export function classifyPlanningNeed(n: NormalizedRequest, complexity?: ComplexityClass): PlanningResult {
  const reasons: string[] = [];

  const steps = (n.text.match(STEP_MARKERS) ?? []).length;
  if (steps >= 1) reasons.push('step-markers');

  const verbs = (n.text.match(TASK_VERBS) ?? []).length;
  if (verbs >= 2) reasons.push('multiple-actions');

  if (complexity === 'COMPLEX') reasons.push('complex');

  const planningNeed: PlanningNeed = reasons.length > 0 ? 'PLAN' : 'NONE';
  return { planningNeed, reasons };
}

export const planningStage: AdmissionStage = {
  id: 'planning-need',
  run(ctx) {
    const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
    if (!normalized) return { ok: true, ctx };
    const complexity = ctx.annotations.complexity as ComplexityClass | undefined;
    const result = classifyPlanningNeed(normalized, complexity);
    return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, planningNeed: result.planningNeed, planningResult: result } } };
  },
};
