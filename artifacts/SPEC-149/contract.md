# SPEC-149 contract — Browser cost and step hard-stops

## Public contract
- Types: `BrowserRunBudget` {costCeilingNanoUsd,maxSteps}, `BrowserRunAccounting` {spentNanoUsd,steps}, `StepAdmission`.
- Fns: `admitStep` (→ ComponentResult<StepAdmission> + advanced accounting), `emptyRunAccounting`.
- Reason codes: STEP_LIMIT_REACHED, COST_CEILING_REACHED, HARD_STOP_MALFORMED.

## Behavior (fail-closed order)
malformed budget/accounting/cost (non-integer/negative) ⇒ FAILED_FINAL/MALFORMED; steps at cap ⇒ FAILED_FINAL/STEP_LIMIT; spent+cost > ceiling ⇒ BUDGET_EXCEEDED/COST_CEILING; else ALLOWED with remaining headroom. Spend exactly at ceiling allowed.

## Money rule
Integer nano-USD only (reuses G03/G04 convention; USD only, no floats/BDT). Float costs rejected — no rounding drift past a ceiling.

## Invariants
INV-01 deterministic (per-step cost from G03 estimator seam; module does integer arithmetic only). INV-05 fail-closed hard-stops. No boolean success; no throw.
