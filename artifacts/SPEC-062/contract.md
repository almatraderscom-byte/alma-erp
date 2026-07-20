# SPEC-062 Contract — Prompt-cache adapter
`PromptCacheAdapter {lookup, store}`, `InMemoryPromptCacheAdapter` (per-provider, first miss then hit + cachedTokens). Seam for real provider caching. Rollback: `git revert --no-edit <SPEC-062 commit>`.
