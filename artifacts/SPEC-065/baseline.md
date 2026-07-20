# SPEC-065 Baseline — Exact deterministic response cache
No response cache existed. New: ResponseCache + InMemoryResponseCache keyed by conversation cache key (tenant-embedded). Identical request -> cached response (no model call). In-memory + durable seam. Additive.
