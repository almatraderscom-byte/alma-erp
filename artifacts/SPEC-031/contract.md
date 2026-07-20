# SPEC-031 Contract — Budget engine + governor
`Budget {scope,key,limitNanoUsd}`, `BudgetStore` (available/state/reserve/commit/
release), `InMemoryBudgetStore` (reserve fails closed if would exceed; actual
clamped ≤ reserved), `orgMonthlyBudget`. Governor: `authorize(worstCase, budgets,
store)` (reserve all-or-nothing, fail-closed; empty budgets → DENY NO_BUDGET),
`settle(auth, actual, store)`, `cancel`. Rollback: `git revert --no-edit <SPEC-031 commit>`.
