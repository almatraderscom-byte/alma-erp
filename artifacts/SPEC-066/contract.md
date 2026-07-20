# SPEC-066 Contract — Semantic cache
`SemanticResponseCache` (put/lookup(tenant, queryEmbedding, threshold) -> best same-tenant hit >= threshold or null). Read-only only; strict tenant isolation. Rollback: `git revert --no-edit <SPEC-066 commit>`.
