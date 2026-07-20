# SPEC-064 Baseline — Conversation cache-key strategy
No cache-key strategy existed. New: conversationCacheKey embedding tenant+prefix+request (tenant-first => isolation structural). Deterministic. Additive.
