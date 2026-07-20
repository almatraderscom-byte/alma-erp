# SPEC-161 Contract — Task-class model performance records
- `PerfObservation` (INPUT) + `perfObservationSchema` (zod, fail-closed): per-mille
  quality (0..1000), integer latencyMs, integer nano-USD cost.
- `PerfRecord` aggregate (integer sums only; no floats/derived state stored).
- `InMemoryPerformanceRecordStore.observe/get/list` — deterministic aggregation.
- Derived (integer, floor): `successRateMilli`, `avgQualityMilli` (0 on no samples —
  fail-safe), `avgLatencyMs`/`avgCostNanoUsd` (MAX_SAFE_INTEGER on no samples — unknown
  = worst, never "fastest/free"). Feeds the measured router (SPEC-164).
