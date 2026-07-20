# SPEC-061 Contract — Prefix hash
`cacheablePrefixProvenance(compiled)`, `prefixCacheKey(compiled)` (pfx_ + sha256 of cacheable bundle id@version#order), `prefixCacheableTokens`. Stable across dynamic changes; invalidates on cacheable-bundle version change. Rollback: `git revert --no-edit <SPEC-061 commit>`.
