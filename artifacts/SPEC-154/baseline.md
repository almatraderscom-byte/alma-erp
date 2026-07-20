# SPEC-154 Baseline — Cheap specialist T2 tier
## Discovery
```text
$ rg -n "T2" src/agent/models/tier-handler.ts   → not registered (T0,T1 only)
$ rg -n "t2|T2_ROLES" src/agent/models           → NONE
$ rg -n "role" src/agent/models/registry.ts      → T2 bindings carry role hints (ops/cs)
```
- Current: fabric + T0/T1 (SPEC-151..153). No T2.
- Direct provider/db calls: none.
- Tests: 39 green pre-spec. Cost/latency: 0 model calls.
- Bypass paths: unrestricted role → wrong cheap model; prevented by closed role set.
- Migration boundary: additive; register `T2`.
- Files expected: `t2.ts` (new), `tier-handler.ts`, `index.ts`, tests, artifacts.
