# Phase 64 — Connect the autonomy ladder to the universal guard

Branch: `agent-phase-64` (stacked) · Tag: `pre-agent-phase-64`
Goal: make the control-center ladder an actual execution policy, not a disconnected KV display (closes GAP-03: `effectiveStage()` had one non-test occurrence — its own definition).

## What was built

1. **Complete `tool → task class → tier` map (CI-enforced)** — `taskClassForTool()` + `tierForTaskClass()` in `autonomy-task-catalog.ts`. Explicit overrides seeded from every family's `representativeTools`; conservative fallback by tier for anything unmapped (unknown writes → R3, never lax). A test asserts every representative tool round-trips to its family.
2. **Pure ladder → guard verdict** — `ladderGuardVerdict(stage, mode, isOwnerDirect)` in `autonomy-rollout.ts`: off/shadow/suggest → **block**, draft → **stage**, auto_r1/bounded_r2 → **allow**. Owner-direct and reads are never gated. **It can only tighten the base guard, never loosen it.**
3. **`effectiveStage()` wired INTO the central guard** — `guardToolCall()` now, for agent-initiated (non-owner-direct) writes/stages, resolves the task class, reads its effective rung, and (in enforce mode) tightens a base `proceed` to block/stage. The ladder decision (`ladderTaskClass`, `ladderStage`, `ladderVerdict`, `ladderEnforced`) is attached to the `GuardOutcome` for the trace. **No second executor path** — this is inside the one guard every tool call already goes through.
4. **Enforcement gate** — `ladderEnforcementMode()`: `off | shadow | on`; unset → **on in preview, shadow in production**. So production behaviour is unchanged (annotate-only) until the owner flips it, while preview actually enforces (satisfying the exit gate). Fail-closed: an unreadable ladder blocks an enforced agent write.
5. **Real outcomes fed back** — `runRegisteredTool()` calls `feedLadderOutcome()` after every agent-initiated effect: `recordReadinessEvidence()` (one sample, correct/incorrect) + `recordRolloutOutcome()` (auto-rollback bookkeeping). A ladder-enforced block is also recorded. This is what makes the readiness/rollout tables receive **live class-scoped rows**.

## Safety design

- **Ladder can only tighten.** It never turns a base block/deny into a proceed — so no existing safety rule is weakened.
- **Owner-direct R0/R1 stays usable** — the ladder is not even consulted for owner-direct calls (verified by test).
- **Production stays shadow** by default (every task class also defaults to `off`) — zero live behaviour change until the owner enables it. The Phase 61 truth panel already shows the ladder as `unwired`→ now it can show live rows.
- **Risk ceiling preserved** — promotion still can't exceed `maxStageForTier` (R3 caps at draft, R4 at shadow); untouched.

## Self-verification (Claude's end)

- **Full agent suite 182 files / 2319 tests PASS** — the central guard + executor were edited, so the whole suite ran as regression. Zero failures.
- **`tsc --noEmit` = 0 errors.**
- **New test (12 cases)** proves: the complete map round-trips + conservative fallback; the pure verdict mapping; the enforcement gate; and the **exit gate** — `on` + rung `off` blocks an agent write (`ladderEnforced=true`), `on` + rung `auto_r1` does not, shadow annotates without enforcing, owner-direct is never gated.

## Exit-gate check

- ✅ Changing one rung changes the actual guard decision in preview and appears in the trace (`ladderStage`/`ladderVerdict` on the outcome + tool-event detail).
- ✅ A control change cannot widen risk beyond the catalog maximum (existing `maxStageForTier`, untouched).
- ✅ Agent-initiated R3 stays blocked/staged unless its class is promoted; owner-direct is unaffected.
- ⏳ "SLO table receives real class-scoped rows" — Phase 64 feeds readiness + rollout evidence now; the SLO *effect* rows depend on the Phase 65 effect engine.

## Definition-of-Done (honest)

| Level | State |
|---|---|
| 1. Implemented | ✅ map + verdict + guard wiring + outcome feed + tests |
| 2. Deployed | ⏳ owner merge/deploy |
| 3. Reachable | ✅ inside the one guard every tool call uses; 2319-test suite green |
| 4. Enabled/used | ⏳ owner: promote only `erp-reporting` + `research-public` to shadow after approval; prod stays shadow-mode until then |
| 5. Outcome | ⏳ real class-scoped readiness/rollout rows accrue once agent-initiated effects run under the flag |
