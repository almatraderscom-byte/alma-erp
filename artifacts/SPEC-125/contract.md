# SPEC-125 — Contract (cost-authorization.ts)
- `costAuthorizationStage: GatewayStage` — estimated≤0 → advance (free). Else
  reserve `deps.budget` on `deps.budgetStore`; null OR missing governor →
  BUDGET_EXCEEDED (fail-closed). Success → advance with `reservation{id,amountNanoUsd}`.
- Wired fourth in DEFAULT_STAGES (after policy).
