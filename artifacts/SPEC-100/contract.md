# SPEC-100 — Contract (regression-gate.ts, v1.0.0)
- `evaluateFirewallGate(observedAtMs=0): FirewallReport{certified, checks[8],
  blockers, summary}`. Checks (all must pass; fail-closed):
  SHORTLIST_BOUND, SCHEMA_MINIMIZED, ARG_FAILCLOSED, EVIDENCE_STORED, VIEW_BOUNDED,
  SECRET_REDACTED, PROVENANCE_TRACEABLE, NORMALIZE_BOUNDED.
- Boundary `queryFirewallGate(raw): ComponentResult<FirewallReport>` —
  identity-enforced; never throws.
