# SPEC-008 Contract — Feature flag & rollback
`FEATURE_MODES`, `decide(mode)` (authoritative-path semantics), `canTransition`
(ladder; rollback always reachable), `rollbackTarget` (last-known-good, never
enforce), `getMode` (defaults off), `featureFlagSchema`. Zero model calls.
Rollback: `git revert --no-edit <SPEC-008 commit>`.
