# SPEC-019 Unresolved Risks
Critical unresolved risks: **0**.
Tracked seam (non-blocking): in-memory store is single-process; a durable
Redis-backed DedupStore must be wired before admission spans instances (VPS
Redis, per owner decision). Interface is ready; no fake durability shipped.
