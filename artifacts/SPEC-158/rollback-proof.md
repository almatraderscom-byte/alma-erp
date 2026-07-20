# SPEC-158 Rollback Proof — Provider timeout and quota controls

Additive change; nothing in production imports it; revert restores the exact
parent tree.

```text
parent(pre-spec) tree: 7bb6510322f08adbd85bd969f9b19d69580c92c7
post-revert   tree:    7bb6510322f08adbd85bd969f9b19d69580c92c7
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-158 commit>` (drill executed live post-commit).
