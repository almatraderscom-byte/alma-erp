# SPEC-071 — Rollback proof

The spec is one additive commit in the owned zone. Rollback = `git revert` of that
commit, which must restore the parent tree **exactly** (byte-for-byte).

## Drill

```
PARENT_TREE=$(git rev-parse 'HEAD^{tree}')      # before the spec commit
# ... spec commit is HEAD ...
git revert --no-edit HEAD                        # produce the inverse commit
REVERT_TREE=$(git rev-parse 'HEAD^{tree}')
test "$REVERT_TREE" = "$PARENT_TREE"  &&  echo "ROLLBACK OK: tree restored exactly"
git reset --hard HEAD~1                           # drop the revert, keep the spec
```

## Result (actual)

```
parent_tree = 06a646661d6148092c0f0fddc9e26a0cf6fcfea6
revert_tree = 06a646661d6148092c0f0fddc9e26a0cf6fcfea6
ROLLBACK OK: tree restored exactly   (parent_tree == revert_tree)
```
Verdict: **PASS** — `git revert` reproduced the parent tree byte-for-byte; the
spec commit was then restored (`git reset --hard`), leaving exactly one commit.

Because every change is confined to new files under `src/agent/tools/registry/`
and `artifacts/SPEC-071/`, reverting removes them cleanly and the parent tree is
reproduced exactly. No feature flag is needed to disable runtime behaviour: the
new module has zero call sites in production yet (it is consumed only by later
G08 specs and its own tests), so removal is inert for the live system.
