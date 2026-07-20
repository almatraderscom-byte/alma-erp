# SPEC-018 Contract — Risk
`RISK_TIERS`, `classifyRisk(n)` → {risk, reasons}, `riskStage`. HIGH for
money/destructive; fail-closed money+side-effect → HIGH; money alone ≥ MED.
Deterministic. Rollback: `git revert --no-edit <SPEC-018 commit>`.
