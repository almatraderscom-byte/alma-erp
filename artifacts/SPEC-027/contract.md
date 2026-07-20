# SPEC-027 Contract — Reconciliation
`reconcile(price, estimatedNanoUsd, actual|null)` → `ReconcileResult
{estimatedNanoUsd, actualNanoUsd|null, varianceNanoUsd|null, status}`; statuses
RECONCILED/OVER/UNDER/UNKNOWN; `needsReconciliation()`. Unknown usage never
guessed. Rollback: `git revert --no-edit <SPEC-027 commit>`.
