# SPEC-075 — Contract  (risk-classification.ts, contract v1.0.0)

## SIDE_EFFECT_POLICY: Record<SideEffectKind, SideEffectPolicy>
`{ external, requiresGateway, requiresCostAuth, requiresReconciliation }`
- external_message / external_api_write / money_movement / browser_action →
  gateway + reconciliation (INV-04, INV-06)
- money_movement → also forces effectiveRisk = high
- model_invocation → requiresCostAuth (INV-03)
- push_notification → gateway + external
- none / db_read / db_write / file_write / schedule → internal (no gateway/cost)

## classifyManifest(m): RiskProfile
Aggregates effects → { effectiveRisk, external, requiresGateway, requiresCostAuth,
requiresReconciliation, requiresApproval }. Approval (fail-closed, INV-05) when
mode=stage OR (write & effectiveRisk≠low) OR effectiveRisk=high.

## checkClassification(m) / checkAllClassifications(set): ClassificationIssue[]
READ_HAS_WRITE_EFFECT | WRITE_HAS_NO_EFFECT | MONEY_NOT_HIGH | UNKNOWN_EFFECT.

## Boundary
`classifyToolRisk(raw): ComponentResult<RiskProfile>` — identity-enforced;
inconsistent manifest → FAILED_FINAL (fail-closed); never throws.
