# SPEC-127 — Contract (execution-adapter.ts)
- `executionAdapterStage: GatewayStage` — no adapter ⇒ FAILED_FINAL(DEPENDENCY_FINAL);
  else `adapter.execute({toolName,args,identity})`; non-success (RETRYABLE/
  UNKNOWN_OUTCOME/FAILED_FINAL) propagated verbatim (no blind retry, INV-06); success
  ⇒ advance with rawPayload (+ actualCostNanoUsd). Wired sixth (after approval).
- Tests use a deterministic FAKE adapter — NO real provider/network.
