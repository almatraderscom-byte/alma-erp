# SPEC-055 Contract — Semantic store
`MemoryRecord {id,identity,text,embedding,atMs,tags}`, `cosine(a,b)`, `SemanticMemoryStore` (add/search/size), `InMemorySemanticStore` (fail-closed, tenant-scoped, top-k cosine, deterministic tie-break). Durable pgvector seam. Rollback: `git revert --no-edit <SPEC-055 commit>`.
