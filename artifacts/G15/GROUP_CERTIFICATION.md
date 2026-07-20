# G15 Group Certification — Queue Scheduling and Browser Runtime

```
Group: G15
Specs: SPEC-141..SPEC-150
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## Specs (each: one commit, both gates green, rollback MATCH)

| Spec | Title | Zone | New tests | tsc | Rollback |
|---|---|---|---|---|---|
| 141 | Domain task queues | worker/queues | 15 | 0 | MATCH |
| 142 | Tenant fairness scheduling | worker/queues | 8 | 0 | MATCH |
| 143 | Concurrency and backpressure | worker/queues | 8 | 0 | MATCH |
| 144 | Priority and deadline scheduling | worker/queues | 10 | 0 | MATCH |
| 145 | Worker lease and crash recovery | worker/queues | 7 | 0 | MATCH |
| 146 | Browser plan/perception/action separation | agent/browser-runtime | 13 | 0 | MATCH |
| 147 | Browser compact observation state | agent/browser-runtime | 8 | 0 | MATCH |
| 148 | Browser replan limits | agent/browser-runtime | 6 | 0 | MATCH |
| 149 | Browser cost and step hard-stops | agent/browser-runtime | 8 | 0 | MATCH |
| 150 | Queue and browser chaos verification | both zones | 20 chaos invariants (11 queue + 9 browser) + drivers | 0 | MATCH |

Zone tests: `npx vitest run src/worker/queues src/agent/browser-runtime` → 106 passed.

## Group integration checkpoint

- **Full repository test suite** `npx vitest run`: **403 files, 3949 passed | 1 skipped**. Nothing else broke (base was 3843; +106 G15 tests).
- **Full zone typecheck**: `npx tsc -p src/worker/queues/tsconfig.json` → 0; `npx tsc -p src/agent/browser-runtime/tsconfig.json` → 0.
- **Architecture bypass scan**: `node scripts/architecture/check-forbidden-imports.mjs` → PASS (0 new forbidden imports; ERP app/api → agent: 0).
- **Tenant isolation**: proven per spec (cross-tenant enqueue/dequeue reject; per-tenant fairness + concurrency isolation) and re-driven in chaos.
- **Cost regression**: none — the deterministic cores add zero model/tool/USD cost; SPEC-143/148/149 REDUCE runaway cost (backpressure, replan/stall stop, cost/step ceilings).
- **Rollback drill**: every spec `git revert HEAD` → tree == parent (MATCH) → `git reset --hard` restored. Net one commit per spec.
- **DB migrations**: none (no schema touched — additive code only).

## Scope discipline

- Edited ONLY `src/worker/queues/**` and `src/agent/browser-runtime/**` (+ `artifacts/**`).
- 0 modifications / 0 deletions to any pre-existing file (128 files changed, all insertions).
- Never touched: prisma/schema.prisma, /api/agent/*, Hermes auth, src/lib/money.ts, any src/app ERP file, root lockfiles, CI config.

## Security posture

- **INV-01 deterministic**: no LLM / DB / network / Date.now / Math.random in any core; nowMs/ids/costs/findings injected; provider/model/browser/probe behind adapter seams with deterministic fakes.
- **INV-02 identity**: every task/plan/observation/action carries a full ExecutionIdentity; cross-tenant ops rejected.
- **INV-05 fail-closed**: every undecidable/at-capacity/malformed case denies or hard-stops; never a bare boolean, never a thrown error across a boundary (G01 ComponentResult everywhere; isSuccess() narrowing).
- **INV-06 reconcile-not-retry**: crash recovery reuses G14 lease + reconcile — requeues only on verified effect-absence, escalates unknowns to dead-letter, never blind-retries.
- **INV-07 bounded views**: browser observation is compact, size-capped and secret-redacted (values dropped, secret labels redacted, byte ceiling fail-closed); tasks carry evidence refs, not payload bodies.
- **Money**: integer nano-USD only (G03/G04 convention); float/negative costs rejected so no drift past a ceiling.
- **Browser hard-stops**: cost ceiling + step ceiling (149) and bounded replans + stall stop (148); actions cannot target non-present (hallucinated/injected) elements (146).

## Verdict: PASS
