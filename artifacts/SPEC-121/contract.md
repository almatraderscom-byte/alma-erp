# SPEC-121 — Contract (contract.ts, v1.0.0)
- `ExecutionAdapter.execute(input): ComponentResult<AdapterResult>` — the ONLY
  provider/network seam (faked in tests; INV-01).
- `GatewayDeps { adapter, observedAtMs, ... }` — injected seams (grow per stage).
- `GatewayContext` — identity + toolName/args/action/estimatedCostNanoUsd +
  accumulators (reservation/obligations/rawPayload/evidenceId/view/actualCost/audit).
- `GatewayStage = (ctx) => ComponentResult<GatewayContext>`.
- `runPipeline(ctx, stages)` — runs in order; FIRST non-success short-circuits and
  is returned verbatim (fail-closed); success → COMPLETED ctx.
- `advance(ctx, patch)` / `stop(status, reasonCodes)` — stage helpers.
- Boundary `invokeTool(raw, deps, stages): ComponentResult<GatewayResultValue>` —
  validates envelope (identity + version + payload); never throws.
