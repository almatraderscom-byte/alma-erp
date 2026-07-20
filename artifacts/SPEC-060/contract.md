# SPEC-060 Contract — Retrieval eval
`RetrievalCase {name, queryEmbedding, relevantIds, k}`, `evaluateRetrieval(store, tenantId, cases, nowMs)` -> `{cases, meanPrecisionAtK}`. Deterministic quality gate over the store+ranking. Rollback: `git revert --no-edit <SPEC-060 commit>`.
