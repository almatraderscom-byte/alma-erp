# SPEC-161 Baseline — Task-class model performance records
## Discovery (exact commands)
```text
$ ls src/agent/routing src/agent/runtime        → greenfield (only tsconfig)
$ rg -l "PerfRecord|performance" src/agent/routing → NONE
$ rg -n "@/agent/routing|@/agent/runtime" src     → NONE (no callers yet)
$ grep export src/agent/finops/tokens.ts          → TokenUsage, estimateTokens (G03 inputs)
$ grep export src/agent/models/tiers.ts           → ModelTier T0..T4, TIER_DEFINITIONS (G16)
```
- Current implementation: none (greenfield in both owned zones).
- Callers/downstream: none yet; the measured router (SPEC-164) consumes these records.
- Direct provider/model/db calls: none — records are INPUTS (offline eval), no live measurement.
- Current tests: none for routing; base suite green (models zone 60).
- Cost/latency evidence: n/a — deterministic aggregation, 0 model calls.
- Tenant/audit: model performance is global telemetry (not tenant data); the ROUTER
  decision (SPEC-164) is the identity-bearing authoritative op.
- Bypass paths: non-integer/float drift in aggregates → non-determinism. Prevented:
  integer-only sums + floor-based derived metrics (per-mille).
- Migration boundary: additive, new zone; nothing imports it yet.
- Files expected: src/agent/routing/performance-records.ts (+ index, tests), artifacts.
