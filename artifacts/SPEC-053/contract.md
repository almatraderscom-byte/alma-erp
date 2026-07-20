# SPEC-053 Contract — Approval state
`PendingApproval`, `ApprovalStore` (request/resolve-once/get/isActionable). Fail-closed: only explicit approval is actionable; pending/rejected/unknown are not. Rollback: `git revert --no-edit <SPEC-053 commit>`.
