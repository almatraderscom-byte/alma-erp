# SPEC-079 — Rollback proof

Two layers of rollback:
1. Code: one additive commit in the owned zone; `git revert` restores the parent
   tree exactly (drill below).
2. Runtime: the registry is feature-flagged. `rollback` mode returns authority to
   the legacy monolith immediately (test: authoritative==='legacy' under rollback),
   so an enforce-time regression is reversed without a deploy (INV-08).

## Drill
```
PARENT_TREE=$(git rev-parse 'HEAD~1^{tree}')
git revert --no-edit HEAD ; REVERT_TREE=$(git rev-parse 'HEAD^{tree}')
test "$REVERT_TREE" = "$PARENT_TREE" && echo OK ; git reset --hard HEAD~1
```

## Result (actual)
```
parent_tree = 96e4e2e3a164f4a99343d98085ec9efd6ad0230d
revert_tree = 96e4e2e3a164f4a99343d98085ec9efd6ad0230d
ROLLBACK OK: tree restored exactly (parent_tree == revert_tree)
```
Verdict: **PASS** — git revert reproduced the parent tree; the spec commit was
then restored (git reset --hard), leaving exactly one commit for SPEC-079.
