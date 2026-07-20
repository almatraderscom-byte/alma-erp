# SPEC-028 Contract — Cost ledger
`CostEvent` (identity + provider/model + estimated/actual nano-USD + status +
priceVerified + observedAtMs), `costEventSchema`, `CostLedger` interface
(record/all/query/totalNanoUsd), `InMemoryCostLedger` (fail-closed validation,
copy on read). Durable store = future seam (prisma/agent-cost/*.proposed).
Rollback: `git revert --no-edit <SPEC-028 commit>`.
