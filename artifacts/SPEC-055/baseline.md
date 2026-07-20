# SPEC-055 Baseline — Semantic long-term memory store
No semantic memory existed. New: MemoryRecord + InMemorySemanticStore (cosine search). Embeddings are INPUTS (no embedding API call -> deterministic, INV-01). Durable pgvector = proposed migration (prisma/agent-memory, NOT applied); live DB untouched. Tenant-scoped. Additive.
