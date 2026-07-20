# SPEC-057 Contract — Relevance
`recencyFactor(atMs, nowMs, halfLifeMs)`, `scoreRelevance(hit, opts)` -> ScoredHit, `rankByRelevance(hits, opts)`. Blends similarity+recency (weighted); deterministic tie-break. Rollback: `git revert --no-edit <SPEC-057 commit>`.
