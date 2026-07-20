# SPEC-145 rollback proof
`git revert --no-edit HEAD` removes worker-lease.ts + barrel line; tree == parent (MATCH); reset --hard restores. One commit. Runtime: `off` = no recovery, `enforce` = lease+reconcile recovery.
