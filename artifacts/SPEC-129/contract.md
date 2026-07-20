# SPEC-129 — Contract (audit-finalization.ts)
- `auditFinalizationStage: GatewayStage` — commits actual = min(actualCost ??
  reserved, reserved) to `deps.budgetStore`; emits ONE `AuditEvent`
  {identity, component:'tool-gateway', status:COMPLETED, evidenceIds, contractVersion,
  observedAtMs} via `deps.auditSink` (seam). Advances with audit + actualCost.
- `AuditSink = (AuditEvent) => void`.
- contract.ts additive: runPipeline releases a pending reservation on abort
  (structural `deps.budgetStore.release`) — no budget leak. Wired eighth (last).
