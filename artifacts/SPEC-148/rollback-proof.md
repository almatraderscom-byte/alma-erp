# SPEC-148 rollback proof
`git revert --no-edit HEAD` removes replan.ts + barrel line; tree == parent (MATCH); reset --hard restores. One commit. Additive; `off` = unbounded (legacy risk), `enforce` = bounded replans + stall stop.
