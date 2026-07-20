# G04 — GROUP CERTIFICATION

Group: G04 — Hard Cost Governor
Branch: `aios/G04-cost-governor` (base = G01+G02+G03 merged)
Base tree: `e86fc913…`

```
Group: G04
Specs: SPEC-031..SPEC-040
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G04 built
The Hard Cost Governor — realises INV-03 (every model call pre-authorised). It
reserves G03's worst-case cost against budgets BEFORE a call and settles the
actual after, so spend can never exceed a limit. All money integer nano-USD (USD
only). Eight budget scopes + a denial policy + an overspend gate:

| Spec | Deliverable |
| --- | --- |
| SPEC-031 | budget engine (reserve → commit/release) + governor authorize/settle + org monthly budget |
| SPEC-032 | business budget (Lifestyle/Trading/CDIT) |
| SPEC-033 | user / service-account budget |
| SPEC-034 | workflow budget |
| SPEC-035 | turn budget |
| SPEC-036 | individual model-call ceiling |
| SPEC-037 | tool-loop total (runaway-loop bound) |
| SPEC-038 | browser-task budget |
| SPEC-039 | denial + degradation policy (DENY default, DEGRADE opt-in) |
| SPEC-040 | overspend gate — 2000-op fuzz proving spent+reserved ≤ limit always |

## Group integration checkpoint
| Check | Result | Evidence |
| --- | --- | --- |
| Full repository typecheck | **PASS** | `npx tsc --noEmit` → exit 0 |
| Full relevant test suite | **PASS** | budgets+cost+finops+control-plane → 155/155 (31 files) |
| Database migration validation | **PASS** | no DB added (in-memory store; durable seam later); schema.prisma untouched |
| Architecture / forbidden-import scan | **PASS** | ERP→agent: 0 new |
| Admission bypass gate (regression) | **PASS** | still 0 bypasses |
| Security (secret scan) | **PASS** | clean |
| Cost & latency vs baseline | **PASS** | 0 model calls (budget MATH); $0.00 |
| Rollback from final group state | **PASS** | revert(base..HEAD) → tree `e86fc913…` = base (MATCH) |
| `GROUP_CERTIFICATION.md` | **PASS** | this file |

## Scope discipline
- 188 files changed vs base, **2435 insertions, 0 modifications, 0 deletions**.
- Every change within `src/agent/budgets`, `src/agent/control-plane/cost` + `artifacts/`.
- **Frozen Hermes API + live `prisma/schema.prisma` — 0 files touched.**

## Money-safety (the headline)
Reserve → reconcile makes overspend structurally impossible: worst-case is
reserved before the call, actual (clamped ≤ reserved) committed after, unused
released. Multi-scope authorize is atomic (any scope over → all reservations
rolled back). Proven by a 2000-operation fuzz where `spent + reserved ≤ limit`
held before and after every operation. Default over-budget action is DENY
(fail-closed); DEGRADE is opt-in and only ever to a cheaper option that fits —
never an invented downgrade (owner decision).

## Owner decisions honoured
1. USD only, integer nano-USD — no BDT anywhere.
2. Budget store in-memory + durable seam (no live DB, no migration).
3. Default limits are owner-tunable placeholders (marked, not authoritative).
4. Over-budget default = DENY; DEGRADE opt-in only.

## Verdict
**G04 PASS.** The Cost Governor is complete, overspend-proof, USD-only, and green.
Production untouched. With G04 done, G05 (Context Compiler) is now unblocked.
This Group Runner does not start another group.
