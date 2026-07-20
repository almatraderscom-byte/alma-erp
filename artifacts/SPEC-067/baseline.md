# SPEC-067 Baseline — Tool-result cache with freshness
No tool-result cache existed. New: ToolResultCache with per-entry TTL; stale never served (evicted on read); ttl=0 tools never cached. Deterministic. Additive.
