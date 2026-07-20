# SPEC-087 — Contract (health.ts, v1.0.0)
- Signals: ok | degrade | disable | kill | restore.
- `nextHealth(current, signal, reason?): CapabilityHealth` — deterministic transitions
  (ok does not clear a kill-switch; restore clears it and returns healthy).
- `isAvailable(health): boolean` — FAIL-CLOSED: available iff known state, not
  disabled, not kill-switched (degraded is still available).
- `HealthOverrideStore` interface + `InMemoryHealthOverrideStore`; `effectiveHealth`
  = override else catalog.
- `checkHealthMetadata / checkAllHealthMetadata`: UNKNOWN_STATE |
  DISABLED_STATUS_MISMATCH.
- Boundary `queryHealth(raw): ComponentResult` — isAvailable|transition;
  identity-enforced; never throws.
