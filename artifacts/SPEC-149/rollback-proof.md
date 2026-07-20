# SPEC-149 rollback proof
`git revert --no-edit HEAD` removes hard-stops.ts + barrel line; tree == parent (MATCH); reset --hard restores. One commit. Additive; `off` = uncapped (legacy risk), `enforce` = cost+step ceilings active.
