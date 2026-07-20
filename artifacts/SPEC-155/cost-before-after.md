# SPEC-155 Cost — before / after

| Metric | Before | After |
| --- | --- | --- |
| Real model calls | 0 | 0 (deterministic FAKE adapter only) |
| Cost accounting | fake port | **real** G04 governor + G03 pricing/estimator |
| Worst-case reserve | n/a | integer nano-USD via `estimateWorstCaseCost` |
| Actual settle | n/a | integer nano-USD via `estimateNormalCost` |
| Estimated / actual USD (test) | 0 | 0 real spend; budget arithmetic exercised |
| Latency | n/a | deterministic in-memory |

INV-03 now demonstrated end-to-end: reserve → invoke → settle; over-budget denies
before any provider call; failure releases the reservation (test-proven, no
dangling spend). No real USD spent — cost is pure arithmetic over the registry.
