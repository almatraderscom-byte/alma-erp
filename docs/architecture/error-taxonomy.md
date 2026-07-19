# Canonical Error Taxonomy (G01 / SPEC-006)

Source: `src/agent/contracts/errors.ts`. Enforces "no untyped exceptions across a
boundary" and INV-06 (unknown outcomes are reconciled, never blindly retried).

| Category | ComponentResult status | Reason code | Retryable |
| --- | --- | --- | --- |
| VALIDATION | FAILED_FINAL | MALFORMED_INPUT | no |
| IDENTITY | FAILED_FINAL | MISSING_ACTOR | no |
| TENANT | DENIED | CROSS_TENANT | no |
| BUDGET | BUDGET_EXCEEDED | BUDGET_EXCEEDED | no |
| POLICY | DENIED | POLICY_DENIED | no |
| APPROVAL | NEEDS_APPROVAL | APPROVAL_REQUIRED | no |
| TIMEOUT | RETRYABLE | TIMEOUT | **yes** |
| DEPENDENCY_RETRYABLE | RETRYABLE | DEPENDENCY_RETRYABLE | **yes** |
| DEPENDENCY_FINAL | FAILED_FINAL | DEPENDENCY_FINAL | no |
| UNKNOWN_OUTCOME | UNKNOWN_OUTCOME | UNKNOWN_OUTCOME | no (→ reconcile) |
| INTERNAL | FAILED_FINAL | DEPENDENCY_FINAL | no |

- `AiosError(category, message, opts)` — typed error.
- `toComponentFailure(err)` — deterministic map.
- `normalizeError(unknown)` — the boundary net: any throw → typed failure, never
  re-thrown, never silent success.

Rollback: `git revert --no-edit <SPEC-006 commit>`.
