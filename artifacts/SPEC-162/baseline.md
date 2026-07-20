# SPEC-162 Baseline — Cost-quality model score
## Discovery
```text
$ rg -n "costQuality|cheapness" src/agent/routing → NONE
$ rg -n "avgQualityMilli|avgCostNanoUsd" src/agent/routing/performance-records.ts → SPEC-161 metrics available
```
- Current: SPEC-161 records + derived metrics; no scoring yet.
- Direct provider/db calls: none — pure integer scoring over G03 cost inputs.
- Tests: 5 green pre-spec. Cost/latency: 0 model calls.
- Bypass paths: float drift; a no-cost model scoring high. Prevented: integer math;
  unknown/over-reference cost → cheapness 0 (fail-safe).
- Migration boundary: additive; consumed by the measured router (SPEC-164).
- Files expected: routing/cost-quality-score.ts, index.ts, tests, artifacts.
