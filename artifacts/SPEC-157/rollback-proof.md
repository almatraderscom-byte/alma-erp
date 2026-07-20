# SPEC-157 Rollback Proof — Provider capability discovery

Additive change; nothing in production imports it; revert restores the exact
parent tree.

```text
parent(pre-spec) tree: 8fea17e1aa7424915d5a5704979d3f520ef19391
post-revert   tree:    8fea17e1aa7424915d5a5704979d3f520ef19391
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-157 commit>` (drill executed live post-commit).
