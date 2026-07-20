# SPEC-061 Baseline — Stable-prefix hashing
No prefix cache key existed. New: prefixCacheKey from G05 cacheable-bundle provenance — unaffected by dynamic suffix (enables prompt caching), changes iff a cacheable bundle changes. Deterministic (sha256). Additive, new zone src/agent/cache.
