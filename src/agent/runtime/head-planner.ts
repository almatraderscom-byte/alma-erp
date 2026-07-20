/**
 * Frontier head planner contract (G17 / SPEC-168).
 *
 * The frontier/head model is allowed exactly one job: PLANNING. It takes a request
 * and emits a typed plan whose steps each execute on a DE-ESCALATED, non-frontier
 * tier (SPEC-167). The head is never the default executor — it produces a plan and
 * hands the steps to cheaper worker tiers. This is the structural enforcement of
 * the frozen "no frontier head model as a default" invariant.
 *
 * Deterministic and fail-closed: the injected planner is a pure function (the real
 * head model call is a documented seam, faked in tests — INV-01, no provider call
 * here). A plan with no steps, or any step that would execute at frontier / above
 * the de-escalation ceiling, is rejected.
 */
import { completed, executionIdentitySchema, type ComponentFailure, type ComponentResult, type ExecutionIdentity } from '@/agent/contracts';
import type { ModelTier } from '@/agent/models';
import { assertDeEscalated } from './de-escalation';

export const HEAD_PLANNER_REASON_CODES = {
  MISSING_IDENTITY: 'HEAD_PLANNER_MISSING_IDENTITY',
  EMPTY_PLAN: 'HEAD_PLAN_EMPTY',
  DUPLICATE_STEP: 'HEAD_PLAN_DUPLICATE_STEP',
} as const;

export interface PlanRequest {
  identity: ExecutionIdentity;
  taskClass: string;
  /** the tier the head plans at — may be high/frontier (the gated exception) */
  planningTier: ModelTier;
}

export interface PlanStep {
  stepId: string;
  taskClass: string;
  /** the tier this step EXECUTES on — must be de-escalated + non-frontier */
  executionTier: ModelTier;
}

export interface HeadPlan {
  planningTier: ModelTier;
  steps: PlanStep[];
}

/** The head model, as a pure injected function. Real model call is a seam. */
export type HeadPlannerFn = (req: PlanRequest) => PlanStep[];

function fail(codes: string[]): ComponentFailure {
  return { status: 'FAILED_FINAL', reasonCodes: codes, evidenceIds: [] };
}

/** Validate a plan: non-empty, unique step ids, every step de-escalated + non-frontier. */
export function validateHeadPlan(plan: HeadPlan): ComponentResult<HeadPlan> {
  if (plan.steps.length === 0) return fail([HEAD_PLANNER_REASON_CODES.EMPTY_PLAN]);
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.stepId)) return fail([HEAD_PLANNER_REASON_CODES.DUPLICATE_STEP]);
    seen.add(step.stepId);
    const check = assertDeEscalated(plan.planningTier, step.executionTier);
    if (check.status !== 'COMPLETED') return check as ComponentFailure; // propagate the exact de-escalation failure
  }
  return completed<HeadPlan>(plan, [], { headPlanner: '1.0.0' });
}

export interface HeadPlannerDeps {
  planner: HeadPlannerFn;
}

/**
 * Run the head planner for a request and return a validated plan. The head is used
 * ONLY here (planning); execution of the returned steps happens on worker tiers.
 */
export function runHeadPlanner(req: PlanRequest, deps: HeadPlannerDeps): ComponentResult<HeadPlan> {
  if (!executionIdentitySchema.safeParse(req.identity).success) {
    return fail([HEAD_PLANNER_REASON_CODES.MISSING_IDENTITY]);
  }
  const steps = deps.planner(req);
  const plan: HeadPlan = { planningTier: req.planningTier, steps };
  const validated = validateHeadPlan(plan);
  if (validated.status !== 'COMPLETED') return validated;
  return completed<HeadPlan>(plan, [`head-plan:${req.identity.correlationId}`, `steps:${steps.length}`], { headPlanner: '1.0.0' });
}
