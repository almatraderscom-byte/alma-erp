# SPEC-153 Baseline — Classifier and extractor T1 tier
## Discovery
```text
$ rg -n "T1" src/agent/models/tier-handler.ts   → T1 not registered (only T0)
$ rg -n "t1" src/agent/models                    → NONE (no T1 handler)
$ rg -n "labels" src/agent/models/contract.ts    → absent (added by this spec, optional)
```
- Current: fabric + T0 handler (SPEC-151/152). No T1.
- Callers/downstream: `defaultTierHandlers`.
- Direct provider/db calls: none (FAKE adapter only).
- Tests: 33 green pre-spec.
- Cost/latency: 0 model calls.
- Tenant/audit: via fabric identity validation.
- Bypass paths: using the cheap classifier tier as a general reasoner — prevented
  (taskKind + json-only guards).
- Migration boundary: additive; register `T1`.
- Files expected: `t1.ts` (new), `tier-handler.ts`, `contract.ts` (+optional `labels`),
  `index.ts`, tests, `artifacts/SPEC-153/*`.
