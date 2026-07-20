# SPEC-163 Contract — Latency and availability score
- `speedMilli(latency, ref)` — per-mille (1000 at 0ms; 0 at ≥ ref / unknown / ref ≤ 0).
- `latencyAvailabilityScore({availabilityMilli, avgLatencyMs, refLatencyMs}, weights)` →
  [0..1000]; default 500 availability / 500 speed (must sum to 1000, else throw).
- `scoreRecordLatencyAvailability(record, refLatencyMs)` — SPEC-161 record → score;
  zero-sample → 0; low success rate penalised even when fast.
- Integer-only; deterministic.
