/**
 * Browser cost and step hard-stops (G15 / SPEC-149).
 *
 * The two runaway defenses a browser agent needs on top of replan limits
 * (SPEC-148): a per-run COST ceiling and a STEP-COUNT ceiling. Before each step
 * the executor calls `admitStep`; the step runs only if, after it, BOTH the
 * accumulated cost stays within the ceiling AND the step count stays within the
 * cap. Either ceiling being reached hard-stops the run fail-closed.
 *
 * Money is INTEGER nano-USD only (reusing the G03/G04 convention — USD only, never
 * floats, never BDT). A non-integer or negative cost is rejected fail-closed, so
 * float drift can never leak a run past its ceiling.
 *
 * Pure + deterministic (INV-01): the per-step cost comes from the cost estimator
 * seam (G03); this module only does the integer arithmetic + the stop decision.
 * Returns a G01 `ComponentResult`. Fail-closed (INV-05).
 */
import { allowed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';

export const HARD_STOP_REASON_CODES = {
  STEP_LIMIT: 'BR_STEP_LIMIT_REACHED',
  COST_CEILING: 'BR_COST_CEILING_REACHED',
  MALFORMED: 'BR_HARD_STOP_MALFORMED',
} as const;
export type HardStopReasonCode =
  (typeof HARD_STOP_REASON_CODES)[keyof typeof HARD_STOP_REASON_CODES];

/** Per-run hard limits. All integer; cost in nano-USD (USD only). */
export interface BrowserRunBudget {
  costCeilingNanoUsd: number;
  maxSteps: number;
}

/** Immutable per-run accounting. `spentNanoUsd` is integer nano-USD. */
export interface BrowserRunAccounting {
  readonly spentNanoUsd: number;
  readonly steps: number;
}

export function emptyRunAccounting(): BrowserRunAccounting {
  return { spentNanoUsd: 0, steps: 0 };
}

export interface StepAdmission {
  spentNanoUsd: number;
  steps: number;
  remainingNanoUsd: number;
  remainingSteps: number;
}

function hfail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

function budgetValid(b: BrowserRunBudget): boolean {
  return (
    Number.isInteger(b.costCeilingNanoUsd) && b.costCeilingNanoUsd >= 0 &&
    Number.isInteger(b.maxSteps) && b.maxSteps >= 0
  );
}

function accountingValid(a: BrowserRunAccounting): boolean {
  return (
    Number.isInteger(a.spentNanoUsd) && a.spentNanoUsd >= 0 &&
    Number.isInteger(a.steps) && a.steps >= 0
  );
}

/**
 * Admit (or hard-stop) the next browser step given its estimated integer nano-USD
 * cost. Fail-closed order:
 *   - malformed budget / accounting / cost (non-integer, negative) ⇒ FAILED_FINAL.
 *   - step count already at the cap ⇒ FAILED_FINAL / STEP_LIMIT.
 *   - spent + stepCost would exceed the ceiling ⇒ BUDGET_EXCEEDED / COST_CEILING.
 * Otherwise ALLOWED with the advanced accounting + remaining headroom.
 */
export function admitStep(
  accounting: BrowserRunAccounting,
  budget: BrowserRunBudget,
  stepCostNanoUsd: number,
): { result: ComponentResult<StepAdmission>; accounting: BrowserRunAccounting } {
  if (
    !budgetValid(budget) ||
    !accountingValid(accounting) ||
    !Number.isInteger(stepCostNanoUsd) ||
    stepCostNanoUsd < 0
  ) {
    return { result: hfail('FAILED_FINAL', [HARD_STOP_REASON_CODES.MALFORMED]), accounting };
  }

  if (accounting.steps >= budget.maxSteps) {
    return { result: hfail('FAILED_FINAL', [HARD_STOP_REASON_CODES.STEP_LIMIT]), accounting };
  }

  const projectedSpend = accounting.spentNanoUsd + stepCostNanoUsd;
  if (projectedSpend > budget.costCeilingNanoUsd) {
    return { result: hfail('BUDGET_EXCEEDED', [HARD_STOP_REASON_CODES.COST_CEILING]), accounting };
  }

  const next: BrowserRunAccounting = { spentNanoUsd: projectedSpend, steps: accounting.steps + 1 };
  const admission: StepAdmission = {
    spentNanoUsd: next.spentNanoUsd,
    steps: next.steps,
    remainingNanoUsd: budget.costCeilingNanoUsd - next.spentNanoUsd,
    remainingSteps: budget.maxSteps - next.steps,
  };
  return { result: allowed(admission, [], { browser: '1.0.0' }), accounting: next };
}
