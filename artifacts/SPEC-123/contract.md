# SPEC-123 — Contract (identity-validation.ts)
- `identityValidationStage: GatewayStage` — DENIES on any missing identity field
  (MISSING_TENANT/ACTOR/WORKFLOW/STEP/CORRELATION) and on resourceTenantId ≠
  identity.tenantId (CROSS_TENANT). Advances otherwise. Never throws.
- contract.ts additive: `GatewayContext.resourceTenantId?` +
  payload `resourceTenantId?`. Wired second in DEFAULT_STAGES (after schema).
