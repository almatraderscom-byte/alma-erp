# SPEC-031 Baseline — Org monthly budget + reserve/reconcile engine
No cost governor / budget engine existed. New: Budget + BudgetStore
(reserve/commit/release) + governor authorize/settle/cancel + org monthly scope.
Uses G03 worst-case estimate. Integer nano-USD (USD only). Additive; in-memory
default, durable seam later. Live DB untouched.
