# SPEC-126 — Contract (approval-obligation.ts)
- Frozen seam: `AutonomyEngine.decide(AutonomyDecideInput): ComponentResult<
  {state: AUTONOMOUS|NEEDS_APPROVAL|DENIED, approvalRequestId?}>` via deps.autonomyEngine.
- `approvalObligationStage: GatewayStage` — no engine ⇒ NEEDS_APPROVAL (fail-closed);
  DENIED decision propagated; NEEDS_APPROVAL ⇒ stop NEEDS_APPROVAL (+approvalRequestId,
  NO execute); AUTONOMOUS ⇒ advance; unknown state ⇒ DENY.
- `applyViewObligations(view, obligations): unknown` — wraps G11 applyObligations
  (redact/mask); consumed by SPEC-128 to redact the result view.
- Wired fifth in DEFAULT_STAGES (after cost, before execution).
