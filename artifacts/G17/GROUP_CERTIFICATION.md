# G17 — GROUP CERTIFICATION

Group: G17 — Measured Routing and Head Model Isolation
Branch: `aios/G17-routing` (base = G01–G09 + G16 integrated)

```
Group: G17
Specs: SPEC-161..SPEC-170
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What G17 built

Measured, cost-aware model routing plus the structural isolation of the frontier
head model. Every model choice is now driven by measured performance, and the
frozen invariant **"no frontier head model as a default"** is enforced in code and
guarded by an executable regression gate. Owned zones only: `src/agent/routing`,
`src/agent/runtime`.

| Spec | Deliverable |
| --- | --- |
| SPEC-161 | task-class model performance records (integer-only aggregates; fail-safe zero-sample metrics) |
| SPEC-162 | cost-quality score (cheaper equal-quality wins; unknown-cost can't out-score measured) |
| SPEC-163 | latency-availability score (flaky/unmeasured penalised) |
| SPEC-164 | measured model router — **refuses frontier (T4) as a default**; fail-safe to the non-frontier registry primary |
| SPEC-165 | explicit escalation reason contract (frontier needs a frontier-eligible reason) |
| SPEC-166 | escalation budget enforcement (per-actor daily caps; stricter frontier cap; injected clock) |
| SPEC-167 | de-escalation after planning (execution ceiling below planning; never frontier) |
| SPEC-168 | frontier head planner contract (head plans only; every step de-escalated + non-frontier) |
| SPEC-169 | head-model tool-loop prohibition (head/frontier can never run a tool loop) |
| SPEC-170 | routing & head-isolation regression gate (8 invariant checks over the REAL functions; proven to catch regressions) |

## Integration checkpoint

| Check | Result |
| --- | --- |
| Full repository typecheck | **PASS** (`tsc -p tsconfig.json` exit 0) |
| Scoped typecheck (routing + runtime) | **PASS** (exit 0 each) |
| Owned-zone suite (`vitest run src/agent/routing src/agent/runtime`) | **PASS** (59/59, 10 files) |
| Full repository suite (`vitest run`) | **PASS** (3490 passed, 1 pre-existing skip, 351 files) |
| Database migration validation | **PASS** (0 files touched under `prisma/`; no schema change) |
| Architecture bypass / forbidden-import gate | **PASS** (0 new violations; 101 baselined) |
| Tenant / identity isolation | **PASS** (router/escalation/planner carry `ExecutionIdentity`; missing identity fails closed) |
| Security regression (secrets / network / provider call) | **PASS** (NONE in owned zones) |
| Determinism (INV-01) | **PASS** (no `Date.now`/`Math.random`/`new Date()` in owned runtime code; time/randomness injected; no LLM/provider call) |
| Cost vs baseline | **PASS** (routing is a deterministic decision; 0 real model calls; consumes G03 estimates as inputs) |
| Group rollback drill (revert whole G17 range) | **PASS** (base tree `170d988…` restored exactly) |

## Frozen invariant — "no frontier head model as a default after G17"

Enforced in code at four points and guarded by SPEC-170:

- **Router (SPEC-164):** `ROUTABLE_TIERS = [T1,T2,T3]`; a T4 route request is `DENIED`
  (`ROUTE_FRONTIER_FORBIDDEN`); the no-telemetry fallback is the non-frontier registry
  primary, never frontier.
- **Escalation (SPEC-165/166):** frontier is reachable ONLY via an explicit,
  frontier-eligible reason AND within a stricter daily budget.
- **De-escalation (SPEC-167) + head planner (SPEC-168):** the head may plan at a high
  tier, but every executed step de-escalates and is never frontier.
- **Tool-loop prohibition (SPEC-169):** a head-class (or frontier-tier) invocation can
  never run an agentic tool loop.

The regression gate (SPEC-170) exercises the REAL functions and fails if any of these
regress; its own tests inject a frontier-leaking router and a frontier-returning
de-escalation and confirm the gate CATCHES them.

## Scope discipline

124 files changed, **2493 insertions, 0 modifications, 0 deletions** of any
pre-existing file; every change within `src/agent/routing`, `src/agent/runtime` and
`artifacts/`. Frozen Hermes (`src/app/api/agent`), live `prisma/schema.prisma` and
existing provider code: **0 touched**. G16 adapters + G03 estimates are consumed as
deterministic inputs/fakes — no real provider/model/network call anywhere in the group.

## Integrity note

Two defects were caught by the gates BEFORE any commit and fixed, so no false PASS
was recorded: (1) SPEC-166 imported `ExecutionIdentity` from the wrong module — caught
by `tsc` (vitest was green); (2) SPEC-170 had a wrong check-count assertion — caught by
the failing test. Both were corrected and re-verified against both `tsc` and `vitest`.

## Verdict

**PASS** — 10/10 specs PASS, all integration gates green, 0 unresolved critical
risks, frozen invariant enforced + regression-guarded. G17 is certified. No PR to
main; no other group started.
