# SPEC-052 Contract — Session state
`SessionState {correlationId, identity, status, currentStep, variables, updatedAtMs}`, `SessionStateStore` (put/get/update copy-on-write, fail-closed). Rollback: `git revert --no-edit <SPEC-052 commit>`.
