# Phase 51 — Autonomy baseline: taxonomy, readiness map, and honest numbers

Date: 2026-07-17 (Asia/Dhaka) · Branch: `claude/agent-roadmap-phases-2a10b1`
Source of truth: `src/agent/lib/autonomy-task-catalog.ts`, `src/agent/replay/run-autonomy-replay.ts`, `src/agent/replay/fixtures/autonomy-*.json`

## What this phase measured

Roadmap 3 splits "99% autonomy" into **coverage** (what the agent is authorized/equipped to do) and **reliability** (what finishes correctly with proof). Phase 51 defines the eligible universe and measures today's reality **before enabling anything**. No behaviour changed in this phase — it is inventory + measurement only.

## Inventory (generated from code)

- **287 executable tools** in the capability manifest, all classified (the manifest test fails CI on any missing/orphan entry).
- Risk-ladder distribution (derived by `deriveTier` from mode × risk × domain):

| Tier | Meaning | Tools |
|---|---|---|
| R0 read-only | queries, research, analysis | 150 |
| R1 reversible private | drafts, todos, records, previews | 65 |
| R2 bounded reversible | scheduling, cancellable state, medium writes | 49 |
| R3 consequential | sends, publishes, ads, calls, browser actions | 22 |
| R4 critical | autonomy master policy (`set_autonomy_policy`) | 1 |

- **No money-movement tool exists** — deliberate. The `money-movement` task family is owner-only with zero representative tools; that is asserted by test.
- **15 task families** (personal + business) classified by tier, reversibility, authority, services, duration, blockers, and success evidence — `TASK_FAMILIES`.
- **Flag registry**: 9 off-by-default enable flags (env + KV), each with concrete prerequisites and a rollback action; a test rejects any prerequisite phrased as a date promise.

## Tool readiness (exit gate: unknown ≠ ready)

| Readiness | Count | Rule |
|---|---|---|
| ready | 150 | pure reads only (R0) |
| partial | 107 | staged-card tools + reversible R1/R2 writes — safe pattern exists, but idempotency/proof are not machine-enforced |
| not_ready | 30 | direct consequential writes (R3/R4) — require the Phase 52 guard kernel + Phase 53 effect engine |

Two honest columns are hard-coded `false` at baseline and asserted by test:

- `idempotencyEnforced: false` — classification declares idempotency but **no runtime uses `classification.idempotency`**.
- `proofEnforced: false` — claim-verifier covers a subset of flows; there is **no per-tool postcondition contract**.

## Baseline guard-decision accuracy: **46.1%** (94/204)

204 PII-scrubbed autonomy cases across 12 scenario classes were authored as the constitutional ground truth (`expectedDecision` — the hard autonomy constitution + risk ladder), then compared against an honest model of **today's** enforcement (`baselineDecision`: schema validation + owner-turn read-only gate + stage-card pattern + CS policy bridge; no universal guard).

| Class | Baseline correct | Reading |
|---|---|---|
| normal | 40/40 | happy path already safe: reads run, staged tools stage, owner writes execute |
| partial_failure / provider_outage / rate_limit | 36/36 | authorization decisions unaffected by provider noise (recovery quality is a later metric) |
| high_impact | 8/24 | staged high-risk tools are safe; **direct R3 writes fire without point-of-risk approval; money caps not consulted outside 3 call sites** |
| injected | 4/20 | **untrusted-content instructions are not blocked for any write tool** |
| policy_conflict | 4/16 | autonomy master policy consulted only by CS/cashflow/order surfaces |
| permission_loss | 2/12 | revoked capability fails downstream instead of failing closed |
| ambiguous | 0/16 | no confidence floor outside `decideAutonomy` call sites |
| duplicate | 0/16 | **no exactly-once guard — retries can duplicate effects/cards** |
| stale_state | 0/12 | **approval is not bound to the exact payload** |
| cross_account | 0/12 | no account/business scope check at the tool boundary |

The 53.9% gap is the measured justification for Phase 52 (universal guard: expected 100% on this corpus) and Phase 53 (exactly-once effects). Thresholds were not moved; a test asserts the baseline is **below 100%** so this gap cannot be silently hidden by an easy corpus.

## Metric definitions (for Phases 52–58)

Ten metrics are defined in `AUTONOMY_METRICS` (guard accuracy, eligibility coverage, correct tool, effect correctness, postcondition proof, recovery, rollback, owner interruption, duplicate effects, unapproved high-impact effects). All except guard accuracy are **unmeasured** at baseline — reported as `unmeasured`, never as an implied zero. The rc-* turn-replay suite currently has **1 fixture** — statistically insufficient for correct-tool-rate; expanding it is standing work.

## Known limitations of this baseline

- `baselineDecision` is a code-derived **approximation** of current behaviour (the named workflow-guard set and a few tool-specific self-checks are not modelled). It errs toward crediting the current system, so the real gap is ≥ the measured gap.
- Chrome preview proof for the readiness dashboard is **deferred by owner instruction**: Vercel deploys are disabled for this branch; live browser proof happens at the final all-phases owner verification.

## Verification record

- `npx vitest run src/agent/lib/__tests__/autonomy-readiness.test.ts` — 18/18 PASS (fixture validity, ≥200 cases, class coverage, manifest consistency, constitution consistency, readiness coverage, flag gates, honest-baseline assertions).
- Full corpus + machine-readable baseline report: `docs/proofs/agent-phase-51/`.
