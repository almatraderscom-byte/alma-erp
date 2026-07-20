# SPEC-152 Rollback Proof — Deterministic T0 path

Additive change; nothing in production imports it; revert restores the exact
parent tree.

```text
parent(pre-spec) tree: a60c02b4e1ed6ffeedb0d9f26514bc8d4c5bda93
post-revert   tree:    a60c02b4e1ed6ffeedb0d9f26514bc8d4c5bda93
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-152 commit>` (drill executed live post-commit).
