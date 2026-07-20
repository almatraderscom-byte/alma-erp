# SPEC-165 Contract — Explicit escalation reason contract
- `ESCALATION_REASONS` (finite) + `FRONTIER_ELIGIBLE_REASONS` (HIGH_RISK_DECISION,
  BIG_MONEY, PLANNING_REQUIRED, OWNER_OVERRIDE).
- `validateEscalation({identity, fromTier, toTier, reason})` → `ComponentResult<EscalationGrant>`:
  fail-closed on missing identity (FAILED_FINAL), unknown reason (DENIED REASON_REQUIRED),
  non-upward move (DENIED NOT_UPWARD), frontier without an eligible reason (DENIED
  FRONTIER_REASON_REQUIRED). The ONLY sanctioned path toward T4.
- Pure/deterministic; no implicit escalation.
