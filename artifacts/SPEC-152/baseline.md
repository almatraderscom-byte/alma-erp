# SPEC-152 Baseline — Deterministic T0 path

## Discovery (exact commands)
```text
$ rg -n "RESOLVED|deterministic" src/agent/models/fabric.ts
  → fabric already returns COMPLETED for a handler's RESOLVED result (no provider call).
$ rg -n "T0|defaultTierHandlers" src/agent/models/tier-handler.ts
  → defaultTierHandlers() returned {} — T0 not yet registered.
$ rg -n "t0" src/agent/models
  → NONE — no T0 handler yet.
```
- **Current implementation:** the fabric RESOLVED path exists (SPEC-151); no T0 handler.
- **Callers/downstream:** default handler table (`defaultTierHandlers`).
- **Direct provider/model/db calls:** none — T0 is deterministic by definition (INV-01).
- **Current tests:** SPEC-151 suite (27) green.
- **Cost/latency:** zero — no model call.
- **Tenant/audit:** inherited from the fabric (identity validated before dispatch).
- **Bypass paths:** a T0 miss silently escalating to an LLM tier — prevented (fail closed).
- **Migration boundary:** additive; register `T0` in `defaultTierHandlers()`.
- **Files expected to change:** `src/agent/models/t0.ts` (new), `tier-handler.ts`,
  `reason-codes.ts`, `index.ts`, tests, `artifacts/SPEC-152/*`.
