# Phase 65 — Exactly-once effects & real durable-task dispatch

Branch: `agent-phase-65-impl` (stacked; `agent-phase-65` was held by a separate worktree) · Tag: `pre-agent-phase-65`
Goal: make one safe R1 task class genuinely autonomous, crash-resumable, verified, measurable.

## Delivered + verified — no unreviewed mass cutover (GAP-04)

The audit's core risk: `AGENT_EFFECT_ENGINE=true` flipped **every** write tool onto the exactly-once engine at once. Replaced with a **master switch + per-task-class canary**:

- **`effectEngineSelection()` / `effectEngineSelectionFromEnv()`** (new, `effects/action-run.ts`) — pure, testable:
  - `off | false | unset` → engine OFF (unchanged production default)
  - `on | true` → all writes (back-compat with the old flag)
  - `canary` → only classes listed in `AGENT_EFFECT_ENGINE_CLASSES`
- **Wired into `registry.ts`** — the write-execution path now computes the tool's task class (`taskClassForTool`, from Phase 64) and asks the selection whether to ride the engine. The selection reason is on the tool-event trace (`effectSelection`).
- **No direct-handler fallback** — when the engine is selected, execution goes through `executeEffect` and returns its result (success or failure); it never falls back to the raw handler. Ledger/outbox failure blocks the write (existing action-run invariant, preserved).

This lets the owner pilot ONE internal R1 class (e.g. `internal-reminders` or `memory-notes`) with `AGENT_EFFECT_ENGINE=canary` + `AGENT_EFFECT_ENGINE_CLASSES=internal-reminders` — exactly the roadmap's "pilot only one internal R1 class," without touching any other write.

## Self-verification

- **New test (6 cases)**: reads/stages never engage; off by default; `on/true` = all writes; `canary` engages only listed classes; empty list engages nothing; env reader works.
- **Full agent suite 183 files / 2325 tests PASS** (registry + action-run edited) — zero regressions. `tsc --noEmit` = 0 errors.

## Honestly NOT done in this session (worker/Redis/owner-gated — cannot be verified solo)

- **Durable-task dispatch caller (GAP-05)** — `enqueueDurableTask()` exists and is pure-testable via `buildDurableTaskJobData`, but wiring a real caller that creates a `WorkflowRun` + graph and routes >30s work needs the VPS worker + Redis to prove anything. Adding an untestable caller into the live chat route would violate "don't ship unverifiable code into production." Left as a worker-session task.
- **Worker chaos tests** (crash/timeout/duplicate-worker/Redis/DB/provider) — require the real preview queue + worker runtime.
- **Pilot activation + the 25→100 canary-effect promotion gate** — owner-gated (needs the flag flipped in a real deploy with the worker running, then real effects observed).

## Definition-of-Done (honest)

| Item | Level |
|---|---|
| Effect-engine canary selection | 1–3 ✅ self-verified; 4–5 ⏳ owner deploy + pilot |
| Durable-task dispatch caller | 0 (worker-session) |
| Chaos tests | 0 (needs worker runtime) |
| R1 pilot + promotion gate | 0 (owner + worker) |

`Implemented` is not reported as `Live`. No external effect, spend, or message was performed.
