# SPEC-164 Rollback Proof — Measured model router

Additive change; nothing in production imports it; revert restores the exact parent tree.

```text
parent(pre-spec) tree: d5f7aa9270470e7ab3d490d9afb707965005a276
post-revert   tree:    d5f7aa9270470e7ab3d490d9afb707965005a276
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-164 commit>` (drill executed live post-commit).
