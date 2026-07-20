# SPEC-162 Contract — Cost-quality model score
- `cheapnessMilli(cost, ref)` — per-mille cheapness (1000 at cost 0; 0 at cost ≥ ref,
  incl. the unknown sentinel and ref ≤ 0). Overflow-safe (short-circuits before multiply).
- `costQualityScore({qualityMilli, avgCostNanoUsd, refCostNanoUsd}, weights)` → [0..1000],
  higher = better; default weights 600 quality / 400 cheapness (must sum to 1000, else throw).
- `scoreRecordCostQuality(record, refCost, weights)` — SPEC-161 record → score; zero-sample → 0.
- Integer-only; deterministic; a cheaper equal-quality model always scores higher.
