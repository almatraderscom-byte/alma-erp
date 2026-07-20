# SPEC-149 baseline — Browser cost and step hard-stops

## Discovery commands
- `ls src/agent/browser-runtime` → 146/147/148 present. No cost/step ceiling module.
- `grep -rn 'nanoUsd' src/agent/finops/cost-calc.ts` → G03/G04 integer nano-USD convention (Math.round to integer nano-USD; USD only, no floats/BDT). Reused as the money unit here.
- `grep -n 'browser_task' src/agent/budgets/budget.ts` → G04 already reserves a `browser_task` budget scope; this spec adds the per-run hard-stop that complements that budget.

## Current implementation
None in the owned zone. SPEC-148 bounds replans/stalls; this spec adds the two remaining browser hard-stops required by the group invariants: a per-run COST ceiling (integer nano-USD) and a STEP-COUNT ceiling. A step is admitted only if it stays within both; otherwise the run hard-stops fail-closed.

## Callers / downstream
Composed with SPEC-148 (replan) + SPEC-146 decide loop; the browser executor calls `admitStep` before each model/tool/browser action. Consumed by 150 chaos.

## Direct provider/model/tool/DB calls
None. Pure integer arithmetic over injected accounting; cost per step supplied by the cost estimator (G03 seam) — not computed here (INV-01).

## Tenant / permission / audit propagation
Accounting is per browser-run (scoped by the caller / budgetId). Amounts are integer nano-USD (INV money rule). Ceilings injected.

## Likely bypass paths
- Cost blow-up via many cheap steps → mitigated: step-count ceiling independent of cost.
- Float rounding drift → mitigated: integer nano-USD only; non-integer costs rejected fail-closed.

## Proposed migration boundary
Feature-flag ladder; additive.

## Files expected to change
`src/agent/browser-runtime/{hard-stops.ts,index.ts,__tests__/hard-stops.test.ts}` — additive.
