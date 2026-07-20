# G13 — Group Certification: Central Secure Tool Gateway

```
Group: G13
Specs: SPEC-121..SPEC-130
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What was built

The single deterministic door every external tool side-effect passes through: a
fixed, fail-closed pipeline of stages in `src/agent/tool-gateway`, each speaking the
frozen G01 `ComponentResult<T>` union (no boolean success, no thrown error across the
boundary). Built on G01 contracts, G04 budgets, G10 selection/results, G11 policy,
and the G12 autonomy engine (via its frozen seam). Deterministic (INV-01) — every
provider/network call lives behind the execution ADAPTER seam.

| Spec | Stage | Fail-closed behavior |
|------|-------|----------------------|
| 121 | Gateway request contract | typed envelope + composer; first non-success short-circuits |
| 122 | Schema validation | unknown/oversize/invalid args ⇒ DENY (reuses G10) |
| 123 | Identity validation | missing identity field / cross-tenant ⇒ DENY (INV-02) |
| 124 | Policy decision | G11 decidePolicy; non-ALLOW ⇒ stop; obligations carried |
| 125 | Cost authorization | G04 reserve; over-budget/no-governor ⇒ BUDGET_EXCEEDED (INV-03) |
| 126 | Approval / obligation | G12 autonomy; NEEDS_APPROVAL ⇒ no execute; obligations applied to view |
| 127 | Execution adapter | tools invoked ONLY behind the adapter seam; fake in tests |
| 128 | Evidence capture | full payload → evidence; model gets bounded, redacted view (INV-07) |
| 129 | Audit + cost finalization | commit actual (clamped) + one correlated audit event; release on abort |
| 130 | Direct external-call bypass gate | CI + runtime gate; FAIL on any side-effect that skips the gateway |

## Integration checkpoint results

- **Full-repo typecheck** (`tsc --noEmit`): **0 errors**.
- **Full agent suite** (`vitest run src/agent`): **333 files / 3350 tests PASS**
  (existing suites + 10 new gateway test files; nothing regressed).
- **Owned-zone suite** (`vitest run src/agent/tool-gateway`): **10 files / 60 tests PASS**.
- **G13 gateway bypass gate** (`check-gateway-bypass.mjs`): **PASS** — 1045 files
  scanned, 0 violations (false-positive-free).
- **Forbidden-import gate**: **PASS** — no NEW forbidden imports; ERP app/api → agent: 0.
- **G11 authorization bypass gate**: still **PASS** (unregressed).
- **Ownership**: every changed file is inside `src/agent/tool-gateway/` or the spec
  proof dirs (verified via `git diff --name-only 479b6a583a18aee2757b9e0437b32fbb9b218c0e HEAD`). No `prisma/schema`,
  no `src/app/api/agent` (frozen Hermes), no `src/lib` money code touched.
- **Group rollback drill**: reverting all 10 spec commits restores the branch-base
  tree exactly.

## End-to-end proof (full DEFAULT_STAGES pipeline)

A single `runPipeline(ctx, DEFAULT_STAGES)` with all seams injected:
schema → identity → policy(obligation redact:result) → cost(reserve 500) →
approval(AUTONOMOUS) → execution(adapter payload incl. api_key + actual cost 250) →
evidence(store full) → audit/finalization →
**status COMPLETED**; model view contains **no secret** (`sk-SECRET` redacted) and the
obligation applied (`[REDACTED]`); budget available = 999750 (250 committed, 500
reservation released); **1 audit event**; **1 evidence record**. Full firewall +
authorization + cost governance verified composing.

## Dependency sequencing (as instructed)

Built SPEC-121→125 (need only certified groups) first. Before SPEC-126,
`git fetch && git rebase origin/aios/integration-wave` picked up the latest wave
(G09/G10 import fixes; my 5 commits replayed cleanly, build re-verified). **G12
autonomy was still not folded into the wave**, so SPEC-126 was coded against G12's
FROZEN interface `AutonomyEngine.decide(input): ComponentResult<AutonomyDecisionValue>`
(states AUTONOMOUS/NEEDS_APPROVAL/DENIED) as an injected deps seam — the interface
had NOT changed (nothing to reconcile/flag). When G12 lands, a real `@/agent/autonomy`
engine satisfies this structural seam with no gateway change.

## Cost & latency

Zero request-path cost in the gateway core: deterministic composition, no
model/provider/DB/network call (INV-01/INV-03). Real provider cost is incurred only
behind the adapter and is reserved (125) then reconciled to actual (129).

## Honesty record

Two intermediate failures were caught and fixed BEFORE certifying (PASS never
certified without reading both the vitest summary and the tsc result): a cost-test
typo (SPEC-125) and a bypass-regex test-expectation error (SPEC-130, my test wrongly
expected the bare word "fetch" to match a call-site regex). Both fixed; re-run green.

## Unresolved critical risks

None (0). Per-spec `unresolved-risks.md` records only low-severity, by-design
follow-ups (durable stores as proposed migrations, real adapter wiring, G12
interface re-verification on a future rebase) — all downstream and non-blocking.

Verdict: **PASS**
