# Phase 31 — Truth baseline and executable replay corpus

Date: 2026-07-17 (Asia/Dhaka) · Branch: `claude/agent-roadmap-1-langgraph` · behaviorVersion: `phase31-v1`
Roadmap: `docs/agent-audit/roadmap-1-langgraph-continuity-human-behavior.md` (Roadmap 1, Phase 31)

## What was built

| Piece | File | What it does |
|---|---|---|
| Corpus types | `src/agent/replay/replay-types.ts` | v2 fixture schema: context state (gap, surface, sticky head, workflow, checkpoint, card, turn outcome), classifier fakes, decision expectations, result/report types, deterministic trace ids |
| Corpus | `src/agent/replay/fixtures/rc-0100…rc-0249` | **150 PII-scrubbed cases**: 50 continuity, 30 tool selection, 25 approval/ask-card, 20 personal/listen, 15 failure recovery, 10 cross-surface |
| Runner | `src/agent/replay/run-agent-replay.ts` | Executes the **real** decision code over every fixture; aggregates metrics; emits JSON + HTML report; CLI: `npx tsx src/agent/replay/run-agent-replay.ts` |
| Tests | `src/agent/lib/__tests__/agent-replay.test.ts` | Corpus validity, PII tripwires, determinism, **baseline lock** (exact numbers), named scenarios |
| Tests | `src/agent/lib/__tests__/continuity-replay.test.ts` | Layer B: the real `resolveHeadModelId` with mocked prisma/OpenRouter, sticky-head matrix, listen mode, LangGraph shadow agreement, cross-surface invariance |

### Real code the runner executes (no simulation)

`classifyHeadFastPath`, `isContinuationText`, `detectRoutineIntent`, `matchIntentPacks` + `packsForPendingActionType`, `shouldInjectResumeBrief`, `shouldAutoContinueTurn`, and in Layer B the full `resolveHeadModelId` (prisma sticky lookup + OpenRouter triage/personal classifiers mocked to serve each fixture's declared fakes) plus `runTurnGraphShadow` (a real LangGraph invocation per case).

Binding is the one surface with **no deterministic code to execute today** — that absence is the roadmap's core diagnosis. `deriveCurrentBinding` transcribes the only deterministic gates production has (reply→card match; `workflowRuns.length>0 && isContinuationText` → workflow continuation; listen suppression) and treats the rest as model judgment. Phase 32's continuity-resolver replaces this transcription and the runner will call it directly.

## Inventory (decision surfaces exercised)

- **Head paths**: deny keywords → heavy; outbound-call intent → heavy; personal hint → classifier → listen tier; marketing regex/triage → Qwen head; routine regex/triage → DeepSeek head; short-follow-up stickiness (non-Anthropic, headPickable only); explicit pin + `ANTHROPIC_HEAD_DOWN` redirect (`head-router.ts`).
- **Graph gates**: `turn-graph-shadow` (decision mirror, preview-on), `routine-turn-graph` (9 read intents, LG-1), `action-turn-graph` (log_expense interrupt pilot), workflow/duty/plan/seo/browser audit graphs, `graph-checkpointer` (LG-2).
- **State stores that compete to describe "what is active"**: chat messages, rolling tail summary (`tail-compact`), `WorkflowRun`, task checkpoints (`checkpoint.ts`), pending approval cards, ask cards, open tasks, plan state, browser session state, turn events. **No deterministic focus resolver exists** — confirmed by measurement below.
- **Continuation paths**: ask-card answer binding, workflow-continuation authorization, deadline auto-continue (`continuation-policy.ts`), resume brief ≥6h (`resume-brief.ts`), P0 checkpoint note injection.
- **Compaction**: tail fold after 10 turns keeps 6 (`tail-compact.ts`) — summary, not an executable checkpoint.
- **Surface handoff**: head resolver takes no surface input (verified invariant in Layer B); continuity depends entirely on shared conversation state.

## Baseline results — 150 cases, honest numbers

**110 pass / 40 baseline findings.** Nothing was weakened to make current code pass; the 40 failures are the measured gap the next phases must close.

| Metric | Baseline | Roadmap target | Verdict |
|---|---|---|---|
| Task binding accuracy | **70.1%** (75/107) | ≥99% (Phase 32) | ❌ core gap |
| Continuation-text recognition | **81.6%** (31/38) | — | ❌ CONTINUE_RE too narrow |
| Fast-path classification | **100%** (70/70) | stay 100% | ✅ |
| Routine intent detection | **100%** (14/14) | stay 100% | ✅ |
| Tool-pack recall | **84.8%** (39/46) | ≥95% (Phase 37) | ❌ Banglish gaps |
| Tool-pack precision (forbidden packs) | **100%** (3/3) | ≥90% | ✅ |
| Resume-brief gap rule | **100%** (49/49) | stay 100% | ✅ |
| Auto-continue policy | **100%** (5/5) | stay 100% | ✅ |
| Head-tier resolution (Layer B, real resolver) | **100%** of expectations | — | ✅ |
| Listen suppression (Layer B) | 1 finding | 0 (Phase 36) | ❌ see below |
| LangGraph shadow agreement (scoreable kinds) | **100%**, 0 hard disagreements | ≥98% (Phase 33) | ✅ |
| Repeated-effect risk (verified effect could re-run) | **23 cases** | 0 (Phase 32) | ❌ |

Per category: continuity 32/50 · tool_selection 23/30 · approval_ask_card 24/25 · personal_listen 20/20 · failure_recovery 5/15 · cross_surface 6/10.

### Failure classification (the 40 findings)

1. **No deterministic binding for checkpoints (13 cases)** — every failure-class resume (`provider_error`, `network_loss`, `worker_crash`, `rate_limit`, `browser_disconnect`, `vercel_deadline`, `app_close`, "থামলো কেন?") binds to `none`: resumption is left to model judgment over an injected prompt note. → Phase 32 focus record + resolver.
2. **Natural continuations missed (7 cases)** — "তারপর?", "যেখানে ছিলে সেখান থেকে করো", "ওটাই করো", "baki ta koro", "বাতিল করো" fail `CONTINUE_RE`; the active run is not rejoined deterministically. → Phase 32 resolver rules.
3. **"2–3 replies later" wrong-task class (6 cases)** — after a few unrelated replies, "post ta koi?" / "পোস্ট হয়েছে?" bind to a NEW task (text keywords win over run state) and "oita ses koro" / "তারপর?" bind to none. This is the owner's exact complaint, now quantified. The corpus keeps `repeatedEffectRisk` on these: rebinding wrongly can regenerate the already-verified image. → Phase 32.
4. **State queries unbound (4 cases)** — "ki obostha oi kajer?", "আমরা কোথায় ছিলাম?" have no deterministic path to the run record.
5. **Waiting-state explanations unbound (2 cases)** — blocked-on-card answers rely on prompt notes, not bound state.
6. **Tool-pack recall gaps (7 cases)** — Banglish forms missing from `INTENT_RULES`: `sale`/`khoroch` (finance/erp), `ke ke office e ase` (staff_read), `caption` (social), `call kore bolo` / `call dio` (reminders). Live impact is softened because the routine graph and the outbound-call directive cover several of these paths, but the recall gap is real.
7. **Listen continuity (1 Layer B finding)** — "jani na, emni" right after an emotional exchange re-enters work mode; the personal tier is per-message with no conversation state. → Phase 36.

### Unmeasured in this harness (deferred honestly)

Groundedness, Bangla naturalness/style, latency, and token cost need live model output; end-to-end effect execution needs live tools. They are listed in every report (`unmeasured`) and belong to later phases' live canaries — this corpus measures the decision layer only.

## Determinism & CI

- Fixed `REPLAY_NOW`; no `Date.now`/randomness in scoring; trace ids are content hashes; two consecutive runs are byte-identical (asserted in CI).
- The baseline numbers above are **locked in `agent-replay.test.ts`** — any code change that moves them (either direction) fails CI until the numbers are updated deliberately by the phase that moved them.
- No live secrets/customer data: PII tripwires (BD phone, email, API-key shapes) run over the whole corpus in CI.

## Exit gates

| Gate | Status |
|---|---|
| Corpus distribution + expected outcomes owner-readable | ✅ this doc + per-fixture `description`/`outcome` |
| Replays deterministic for CI, no live secrets | ✅ asserted in tests |
| Baseline failures reported honestly, no weakened thresholds | ✅ 40 findings locked, desired expectations kept |
| Diagnostic page proof with ≥3 named scenarios incl. "2–3 replies later" + "three days later" | ✅ `docs/proofs/agent-phase-31/` (HTML report run in Chrome; Vercel deploys intentionally disabled on this branch per owner instruction — local render of the committed report) |

## Decisions & ambiguities

- Owner instruction for this run overrides the per-phase stop rule: all phases proceed on the single branch `claude/agent-roadmap-1-langgraph`, Vercel deploys disabled (`vercel.json > git.deploymentEnabled`), owner verifies everything at the end before any merge to main.
- `AGENTS.md` referenced by the roadmap does not exist in this repo; `CLAUDE.md` is the governing equivalent and was followed.
- Two fixture-authoring errors found on first run were corrected (attendance pack `camera`→`staff_read`; `onek` added so the personal-hint net fires in `listen-mixed-hisab`) — corrections of the fixtures' own encoding mistakes, not threshold weakening.
