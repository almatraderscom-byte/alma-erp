# SPEC-084 — Contract (permission.ts, v1.0.0)
Privilege lattice owner(3) > staff(2) > customer(1).
- `evaluatePermission(capability, actor): PermissionDecision{decision,requiredScope,reasonCode?}`
  ALLOW iff max(actor privileges) ≥ required scope; DENY on disabled/kill-switch,
  no/insufficient roles (fail-closed).
- `checkPermissionMetadata(c) / checkAllPermissionMetadata(set): PermissionIssue[]`
  DEFAULT_NOT_DENY | MINROLE_MISMATCH | UNKNOWN_SCOPE.
- Boundary `authorizeCapability(raw): ComponentResult` — ALLOWED / DENIED
  (unknown capability → DENIED); identity-enforced; never throws.
