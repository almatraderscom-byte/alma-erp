# G03 — GROUP CERTIFICATION

Group: G03 — Provider Pricing and Cost Accounting
Branch: `aios/G03-cost-accounting` (stacked on certified `aios/G01-architecture-freeze`)
Base tree (G01): `f93be0ef…`

```
Group: G03
Specs: SPEC-021..SPEC-030
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G03 built
Deterministic cost accounting so G04 (Cost Governor) can authorise/deny spend
BEFORE a model call. All money is **integer nano-USD — USD only, no BDT** (owner
decision: exchange rates move daily, so nothing is stored in BDT).

| Spec | Deliverable |
| --- | --- |
| SPEC-021 | versioned pricing registry (nano-USD; source+date+verified per entry) |
| SPEC-022 | tokenizer abstraction + deterministic estimator (seam) |
| SPEC-023 | cached-input pricing (cheaper cached rate) |
| SPEC-024 | reasoning + tool-call cost accounting |
| SPEC-025 | pre-call NORMAL cost estimator |
| SPEC-026 | pre-call WORST-CASE estimator (safe ceiling) |
| SPEC-027 | actual usage reconciliation (unknown → reconcile, INV-06) |
| SPEC-028 | cost event ledger (in-memory + proposed durable migration) |
| SPEC-029 | cost attribution by G01 identity dimensions |
| SPEC-030 | pricing freshness / verification job |

## Group integration checkpoint
| Check | Result | Evidence |
| --- | --- | --- |
| Full repository typecheck | **PASS** | `npx tsc --noEmit` → exit 0 |
| Full relevant test suite | **PASS** | `vitest run src/agent/finops` → 57/57 (10 files) |
| Database migration validation | **PASS** | live `schema.prisma` untouched; proposed model NOT applied; 0 migrations run |
| Architecture / forbidden-import scan | **PASS** | ERP→agent: 0 new |
| Security (secret scan) | **PASS** | clean |
| Cost & latency vs baseline | **PASS** | 0 model calls (cost MATH, not model calls); $0.00 |
| Rollback from final group state | **PASS** | revert(G01..HEAD) → tree `f93be0ef…` = G01 (MATCH) |
| `GROUP_CERTIFICATION.md` | **PASS** | this file |

## Scope discipline
- 193 files changed vs G01 base, **3052 insertions, 0 modifications, 0 deletions**.
- Every change within `src/agent/finops`, `src/agent/providers/pricing`,
  `prisma/agent-cost` (proposed only) + `artifacts/`.
- **Live `prisma/schema.prisma` — 0 changes; no migration executed.** Legacy
  `src/agent/lib/cost-events.ts` — 0 changes (coexists).

## Owner decisions honoured
1. **USD only, no BDT** in accounting (exchange-rate volatility) — integer nano-USD throughout.
2. **DB seam, not a live migration** — durable Prisma model is proposed under `prisma/agent-cost/` for the integration session; production DB untouched.
3. **Prices are estimates** — every entry `verified:false` with source+date; SPEC-030 flags them for verification before they are treated as authoritative.

## Integrity note (transparency)
Mid-group, a rollback-drill helper's `git clean -fdq` deleted uncommitted SPEC-022
work-in-progress. Recovered (files recreated, SPEC-022 re-committed green) and the
helper was fixed to never `git clean` (reset-only). No committed spec was affected.

## Verdict
**G03 PASS.** Cost accounting complete, deterministic, USD-only, and green.
Production DB and live code untouched. Wave 2 (G02 done, G03 done) leaves G08;
this Group Runner does not start another group.
