# SPEC-019 Baseline — Request dedup & replay protection
No dedup/replay guard existed. Uses G01 idempotencyKey + content hash; in-memory
store now, durable Redis store is the documented seam (owner decision — no schema
change this phase). Honors INV-06 (no blind retry). Zero model calls.
