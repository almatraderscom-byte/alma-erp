/**
 * De-escalation after planning (G17 / SPEC-167).
 *
 * A frontier/high tier may be used to PLAN (SPEC-168), but the steps of that plan
 * must EXECUTE on a cheaper tier — and never on the frontier. This is the runtime
 * half of the frozen invariant "no frontier head model as a default": planning is
 * the rare, gated exception; execution always de-escalates.
 *
 * Deterministic, pure, fail-closed: an execution tier at frontier, or above the
 * de-escalation ceiling for its planning tier, is a typed failure. No provider
 * call (INV-01).
 */
import { completed, type ComponentFailure, type ComponentResult } from '@/agent/contracts';
import { MODEL_TIERS, isModelTier, tierRank, type ModelTier } from '@/agent/models';

export const DE_ESCALATION_REASON_CODES = {
  EXEC_FRONTIER_FORBIDDEN: 'EXEC_FRONTIER_FORBIDDEN',
  EXEC_NOT_DEESCALATED: 'EXEC_NOT_DEESCALATED',
  TIER_UNKNOWN: 'DEESCALATION_TIER_UNKNOWN',
} as const;

/** The execution ceiling for a plan produced at `planningTier`: one tier below,
 *  floored at T1 (the cheapest LLM tier) and never the frontier tier. */
export function deEscalatedExecutionTier(planningTier: ModelTier): ModelTier {
  const targetRank = Math.max(1, tierRank(planningTier) - 1); // ≥ T1, and rank-1 of T4 is T3 (never T4)
  return MODEL_TIERS[targetRank];
}

/** An execution tier is valid iff it is not frontier and not above the ceiling. */
export interface DeEscalationCheck {
  planningTier: ModelTier;
  executionTier: ModelTier;
  ceiling: ModelTier;
}

function fail(codes: string[]): ComponentFailure {
  return { status: 'FAILED_FINAL', reasonCodes: codes, evidenceIds: [] };
}

export function assertDeEscalated(planningTier: ModelTier, executionTier: ModelTier): ComponentResult<DeEscalationCheck> {
  if (!isModelTier(planningTier) || !isModelTier(executionTier)) {
    return fail([DE_ESCALATION_REASON_CODES.TIER_UNKNOWN]);
  }
  if (executionTier === 'T4') {
    return fail([DE_ESCALATION_REASON_CODES.EXEC_FRONTIER_FORBIDDEN]);
  }
  const ceiling = deEscalatedExecutionTier(planningTier);
  if (tierRank(executionTier) > tierRank(ceiling)) {
    return fail([DE_ESCALATION_REASON_CODES.EXEC_NOT_DEESCALATED]);
  }
  return completed<DeEscalationCheck>({ planningTier, executionTier, ceiling }, [], { deEscalation: '1.0.0' });
}
