# SPEC-163 Baseline — Latency and availability score
## Discovery
```text
$ rg -n "latencyAvailability|speedMilli" src/agent/routing → NONE
$ rg -n "successRateMilli|avgLatencyMs" src/agent/routing/performance-records.ts → SPEC-161 metrics available
```
- Current: SPEC-161 records + SPEC-162 cost-quality score. No latency/availability score.
- Direct provider/db calls: none — pure integer scoring.
- Tests: 11 green pre-spec.
- Bypass paths: an unmeasured/flaky model scoring high. Prevented: zero-sample → 0;
  unknown latency → speed 0; low success rate penalised.
- Migration boundary: additive; consumed by the measured router (SPEC-164).
- Files expected: routing/latency-availability-score.ts, index.ts, tests, artifacts.
