# SPEC-150 rollback proof
`git revert --no-edit HEAD` removes both chaos modules + tests + barrel lines; tree == parent (MATCH); reset --hard restores. One commit. Verification-only — nothing to roll back at runtime.
