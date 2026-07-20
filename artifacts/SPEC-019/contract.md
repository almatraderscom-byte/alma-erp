# SPEC-019 Contract — Dedup & replay
`DedupStore` interface, `InMemoryDedupStore` (bounded/FIFO), `dedupKey(identity,n)`
(deterministic, sha256 + G01 idempotencyKey), `makeDedupStage(store)`,
`dedupStage` (default). Duplicate → typed FAILED_FINAL/DUPLICATE_REQUEST, never a
blind re-execute (INV-06). Durable Redis store = future seam. Rollback: `git revert --no-edit <SPEC-019 commit>`.
