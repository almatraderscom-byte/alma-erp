# SPEC-165 Rollback Proof — Explicit escalation reason contract

Additive change; nothing in production imports it; revert restores the exact parent tree.

```text
parent(pre-spec) tree: 8a062554b22bedbc0a60749419fc29d7270995df
post-revert   tree:    8a062554b22bedbc0a60749419fc29d7270995df
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-165 commit>` (drill executed live post-commit).
