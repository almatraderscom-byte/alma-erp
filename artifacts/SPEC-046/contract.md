# SPEC-046 Contract — Memory bundle
`memoryBundle(items[], version?)` -> non-cacheable memory bundle; empty content when no items. Truncated first by the allocator. Rollback: `git revert --no-edit <SPEC-046 commit>`.
