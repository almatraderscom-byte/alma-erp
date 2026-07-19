# Phase 62 — Universal continuity & exact task resumption

Branch: `agent-phase-62` (stacked on `agent-phase-61`) · Tag: `pre-agent-phase-62`
Goal: every non-trivial owner task gets a durable identity, current step, verified completed steps, blocker, and next legal action — whether or not it uses a templated workflow.

## What was built

1. **Universal task intake** — `ensureFocusForOwnerTask()` (new, `conversation-focus.ts`). At owner task intake, on a clear `new_task` binding, a durable focus is deterministically created for the ordinary task (not only templated WorkflowRuns / unbacked promises). Closes **GAP-02**.
   - **Idempotent per turn**: the `turnId` is stored in the focus `artifacts` and a re-run (worker fallback / reconnect) returns the existing focus — no duplicate. A second guard skips creation when the current active focus is the same work (≥50% goal-token overlap = continuation, not a new task).
   - Wired into `run-owner-turn.ts` at the resolver decision point, gated on `continuityLive` (shadow/off keep pure legacy behaviour). Fail-open.
2. **Lifecycle updates** — `advanceOwnerTaskFocus()` (new, `conversation-focus.ts`) moves the non-templated active focus's `currentStep` / `completedSteps` / `blocker` at end of turn from the real tool records; templated focuses stay owned by `syncFocusWithWorkflowRun`. Wired at end of `run-owner-turn.ts`.
3. **Binding outcome scoring** — `continuity-outcome.ts` (new): `scoreBindingOutcome()` classifies each turn's binding into the six real outcomes (continued_correct / wrong_task / unnecessary_restart / duplicate_step / asked_clarification / owner_correction). `recordBindingOutcome()` writes a durable `__continuity__` event so the **≥98%-correct-binding-over-≥100-real-turns gate is measured on real traffic**, and `summarizeBindingOutcomes()` computes it. Wired into `run-owner-turn.ts` (records every turn; `owner_correction` derived from the interaction layer's correction signal).
4. **Prose-free completion rule** — `canCompleteFocus({claimVerified, postconditionMet})`: a task completes only when the claim verifier AND the postcondition both hold. Model prose can never complete a task. Plus `wouldDuplicateStep()` for the deterministic duplicate-step guard.
5. **Long-mixed-follow-up FIX** — `continuity-resolver.ts` now recognises a "resume the previous work (but also add X)" lead (`isResumeLeadReference`). Previously "আগের কাজটা চালাও, কিন্তু নতুন এই শর্তটা যোগ করো …" exceeded the short-utterance cap and bound to `new_task`, **parking the very work the owner asked to continue**. It now binds `active_focus` / `resume`.
6. **Duplicate-focus guard** — the commitment-ledger path in `run-owner-turn.ts` no longer forks a second focus when universal intake already created one this turn.

## Self-verification at Claude's end

- **Full agent suite: 181 files / 2307 tests PASS** — the owner-turn path was edited, so the whole suite was run as regression. Nothing broke.
- **Corpus integrity**: `bindingAccuracy === 1` held and the locked baseline count (150) is intact — the resolver fix changed no existing fixture's binding.
- **New tests**: `continuity-outcome.test.ts` (scoring priority, prose-free completion, duplicate-step, recorder evidence shape, ≥98% gate math, fail-open) + `continuity-resolver.test.ts` new blocks (universal-intake trigger, long-mixed-followup resume, no-false-resume).
- **Typecheck**: `tsc --noEmit` = 0 errors project-wide.
- **Before/after** the resolver fix captured in `04-resume-lead-fix.txt`.

## Honest scope notes

- **No corpus fixture added.** A regression fixture for the long-mixed-follow-up was built and validated, but the corpus **baseline-count lock lives in `agent-replay.test.ts`, which is outside the Phase 62 allowlist**. Rather than edit an off-limits test, the fix is locked by `continuity-resolver.test.ts` instead. (Fixture + baseline bump is a clean owner-approved follow-up.)
- **No migration.** The Phase 62 allowlist excludes `schema.prisma`; idempotency reuses the existing `artifacts` JSON column and the outcome stream reuses `agentToolEvent` — no schema change.
- **Completion wiring is partial by design.** `canCompleteFocus` is the ONLY sanctioned completion path and is exposed; wiring a task-specific postcondition for every ordinary task is a larger effort. Ordinary intake focuses currently close by being parked (new task) or via the workflow-sync path; auto-completion via postconditions is a follow-up.

## Definition-of-Done status (honest)

| Level | State | Evidence |
|---|---|---|
| 1. Implemented | ✅ | intake + lifecycle + outcome + resolver fix on branch |
| 2. Deployed | ⏳ owner | needs branch push → preview → owner merge/deploy |
| 3. Reachable | ✅ (self) | wired into the live owner-turn path; 2307-test suite green |
| 4. Enabled/used | ⏳ owner | prod has `AGENT_CONTINUITY_RESOLVER=on`; real focus coverage measured after deploy |
| 5. Outcome | ⏳ owner | the ≥95% coverage / ≥98% binding gates require real production traffic |

## Real-evidence gates (require production traffic — cannot be met in code)

- ≥95% focus coverage for non-trivial tasks · ≥98% correct binding over ≥100 real turns · zero duplicate verified effects · full owner-graph agreement ≥98% over ≥200 turns. These are **measured**, not asserted; the `__continuity__` stream + `summarizeBindingOutcomes()` produce the numbers once the branch is live.

## Owner-gated follow-up

- Push branch → preview → Chrome proof: open a session, start an ordinary (non-templated) task, close/reopen, resume it, confirm same focus id / next step. (Needs owner login on the preview.)
