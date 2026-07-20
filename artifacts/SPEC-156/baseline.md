# SPEC-156 Baseline — Frontier escalation T4 tier
## Discovery
```text
$ rg -n "T4" src/agent/models/tier-handler.ts   → not registered (T0..T3)
$ rg -n "t4|approval|dailyCap" src/agent/models   → NONE
$ rg -n "opus-gate" src/agent/lib/models          → legacy opus daily-cap gate (frozen, not imported)
$ rg -n "identity" src/agent/models/tier-handler.ts → prepare ctx lacked identity (added by this spec)
```
- Current: fabric + T0/T1/T2/T3. No T4.
- Direct provider/db calls: none.
- Tests: 50 green pre-spec.
- Bypass paths: silent auto-escalation into the costly frontier tier; unapproved
  frontier spend — both prevented (fail-closed approval + per-actor daily cap;
  fabric never promotes a tier).
- Migration boundary: additive; register `T4` (default fail-closed), add identity
  to prepare context.
- Files expected: `t4.ts` (new), `tier-handler.ts`, `fabric.ts` (pass identity),
  `index.ts`, tests, artifacts.
