# SPEC-146 rollback proof
`git revert --no-edit HEAD` removes the entire `src/agent/browser-runtime` addition; tree == parent (MATCH); reset --hard restores. One commit. Additive greenfield zone; nothing legacy to break.
