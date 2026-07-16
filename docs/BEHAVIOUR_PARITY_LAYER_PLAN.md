# Behaviour Parity Layer — model-agnostic "Claude-feel" via architecture

**Author:** Claude (architect pass over the live owner-head harness)
**Date:** 2026-07-16
**Goal:** Make ~40–50% of the "Claude feel" come from the **harness**, so that **whatever head model is selected (Grok 4.20 today, DeepSeek/Gemini tomorrow) behaves with the same discipline**. Head stays owner's choice (Grok 4.20). No ERP code, no `/api/agent/*`. All changes additive, in `src/agent/`, behind env kill-switches.

> **Honest ceiling:** the harness can enforce *discipline, grounding, honesty, structure, verification* — that is the 40–50% that makes an agent feel trustworthy and "senior." It **cannot** raise a model's raw reasoning depth; that stays model-bound. This plan maximises the model-agnostic half and leaves the reasoning half to your existing light/heavy routing.

---

## সংক্ষেপে (Bangla)

Boss, ভালো খবর: আপনার harness **আগে থেকেই অনেক শক্ত** — মিথ্যা "হয়ে গেছে" দাবি, choice-card বাধ্যতা, workflow ক্রম, নির্দিষ্ট-tool চুক্তি, খরচ-ক্যাপ — এগুলো **সব মডেলে already যান্ত্রিকভাবে enforce করা** (একটাই ইঞ্জিন সব মডেল চালায়)। তাই নতুন করে বানানোর কিছু নেই।

যা বাকি (এখন শুধু প্রম্পটে অনুরোধ, মডেলের "দয়ার" উপর ছাড়া) — এগুলোকে **শক্ত gate** বানালেই যেকোনো মডেল আমার মতো শৃঙ্খলা দেখাবে:
1. উত্তরের আগে **পড়া বাধ্যতামূলক** (মেমরি থেকে বানিয়ে বলা বন্ধ)
2. জটিল কাজে **আগে প্ল্যান** বাধ্যতামূলক
3. লেখা/সংখ্যা দাবি করলে **যাচাই বাধ্যতামূলক** (শুধু "done" না, যেকোনো তথ্য-দাবি)
4. কাজ শেষে **"আসলে কি হলো?" আত্ম-যাচাই**
5. বড় সেশনে **নিয়ম "ভুলে যাওয়া" ঠেকানো** (নিয়ম বারবার re-inject)
6. একটাই **"সংবিধান" (Constitution)** — প্রতিটা মডেল হুবহু একই আচরণ-চুক্তি পায়

প্রতিটা env-সুইচ দিয়ে বসবে, canary দিয়ে ধীরে চালু হবে — কিছু ভাঙার ঝুঁকি নেই। আপনি confirm করলে ধাপে ধাপে implement করব।

---

## 1. What is ALREADY code-enforced equally across models (do NOT rebuild)

From the harness audit — these are HARD gates in the single `runAlternateProviderTurn` engine + the shared `executeTool` choke point, so every provider (Grok/DeepSeek/Gemini/Claude) gets them identically:

| Discipline | Where |
|---|---|
| No false "done/sent/saved" claims → reject + force rewrite | `claim-verifier.ts` (ledger + `MAX_VERIFY_RETRIES`) |
| Owner choice MUST be an `ask_user` card, never prose options | `claim-verifier.ts` prose-choice / missing-ask guards |
| Illegal workflow step (e.g. post before preview) physically blocked | `workflow-guards.ts::checkWorkflowGuards` inside `executeTool` |
| Required tool per owner request (save_memory, live-browser pages, SEO) | `owner-turn-requirements.ts` + `toolChoice` binding |
| Tool-round spend cap → delegate/text-only when over | `config.ts` `HEAD_TOOL_BUDGET` |
| Confirm-card before irreversible actions, one card at a time | staged-card capability + `ONE_CARD_AT_A_TIME` |
| Rich modular system prompt (honesty, verify, integrity, memory-first) | `system-prompt.ts` (`core:true` modules, CI-linted) |

**Implication:** the "fabrication of actions", "sequence", "card", and "spend" axes are solved and model-agnostic. Our work is the remaining SOFT axes below.

---

## 2. The gaps (SOFT / prompt-only today → target: HARD, model-agnostic)

| Pillar | Today | Gap a weak model exploits |
|---|---|---|
| **P1 Verify-before-commit (facts)** | Verifier keys on *completion verbs* only | Confabulates a **number/status** not phrased as "done" — slips through |
| **P2 Ground-before-answer** | Prompt only; hard only for ads/salah | Answers a live-data question **from memory** |
| **P3 Plan-then-act** | `make_plan` optional (prompt) | **Tool-sprays** a ≥3-step task, no plan |
| **P4 Reflect-on-result** | No in-turn reflection (only background plan-driver) | Ends a write-turn **without checking the write actually succeeded** |
| **P5 Constraint-pinning** | Prompt at top + caching + compaction | Long session → **instruction drift**; compaction can drop rules (governance decay) |
| **P6 Shared Constitution** | Core rules exist but gated by tool groups | No single **always-verbatim, re-injected, compaction-protected** contract → models drift apart |

(P7 Bounded-autonomy/confirm-gates is already HARD — §1 — folded into the Constitution for salience only.)

External grounding for these choices: harness > model ([Agent Harness](https://medium.com/@nraman.n6/the-agent-harness-why-the-infrastructure-around-your-llm-is-more-important-than-the-llm-itself-3a6e5cbb2e97)); verify-before-commit ([AgentLTL trace-verification](https://arxiv.org/pdf/2607.02599)); reflection ([Reflexion/LATS survey](https://github.com/Gloriaameng/Awesome-Agent-Harness)); compaction erasing rules ([Governance Decay](https://arxiv.org/pdf/2606.22528)); instruction drift / re-injection ([Context Rot mitigation](https://arxiv.org/pdf/2606.29718)).

---

## 3. Design — each pillar as a deterministic, model-agnostic gate

The unifying principle (from the research): **a weak model will not self-discipline — so the harness enforces discipline mechanically, and the model just executes the contract.** Every gate below reuses machinery you already have (requirement contract + `toolChoice` binding + verifier retry), so it applies to ALL providers by construction.

### P6 + P5 — The Constitution + anti-drift (foundation; build first)
- **New module `CONSTITUTION` in `system-prompt.ts`:** a distilled (~200-token) non-negotiable behaviour contract — honesty/no-fabrication, ground-before-answer, verify-before-commit, plan-first, reflect-on-write, confirm-irreversible, tone + "Boss". Marked `core: true, pinned: true`; **guaranteed verbatim at the TOP of every head prompt for every model** (never dropped by `compileOrdered` group-gating).
- **Re-injection:** in the loop (`run-owner-turn.ts`), every `CONSTITUTION_REINJECT_EVERY` iterations (default 4) or ~15k tokens, re-inject a 1-line "core rules still apply: verify, ground, no fabrication" system nudge. Kills instruction drift in long turns.
- **Compaction guard:** patch `conversation-compact.ts` so the Constitution + pinned rules are **preserved verbatim, never summarized** (fixes governance decay).
- **Env:** `AGENT_CONSTITUTION` (on/off/shadow). CI: extend `prompt-lint.test.ts` to assert the Constitution is always present + within token budget.

### P2 — Ground-before-answer (hard gate)
- **Extend `owner-turn-requirements.ts::deriveOwnerTurnRequirements`** with a deterministic classifier: if the owner message is a **live-data question** about ERP state (orders, stock, balances, staff, sales, dates) and not already covered by ads/salah rules → set `groundingRequired: true`.
- The loop binds a **read-category tool** via `toolChoice` on round 1 (identical mechanism to today's `memoryRequiredTool`). Model literally cannot answer before reading.
- Conservative: only fires on clear data questions (keyword + intent), fails open to a normal turn on ambiguity. **Env:** `AGENT_GROUNDING_GATE`.

### P3 — Plan-then-act (hard gate)
- **Deterministic complexity estimator** (owner message + selected tool groups + requirement contract): if ≥3 mutating steps likely → bind `make_plan` via `toolChoice` on round 1 (reuse `roundBoundToolName`). Plan-first becomes code-enforced, not prompt-hoped, for all models.
- Reuses the existing `make_plan`/`execute_plan` orchestrator tools (min-2-step already enforced). **Env:** `AGENT_PLAN_GATE`.

### P1 — Verify-before-commit for FACTS (extend the verifier)
- **New `factual-claim-gate.ts`, wired into the same verification retry point** as `claim-verifier.ts`: detect quantitative/state assertions in the final reply (numbers, counts, money amounts, dates, "X আছে/নেই/হয়েছে") about live entities. If **no read tool touched that entity this turn** and it's not quoted from history/memory → reject + force either a read or an explicit hedge ("যাচাই করিনি — আনুমানিক")। Closes the "confabulate a stat not phrased as done" hole.
- Reuses the verifier's ledger + `MAX_VERIFY_RETRIES` retry loop → model-agnostic. **Env:** `AGENT_FACT_GATE`. Tuned to avoid false positives on clearly-hedged or history-sourced numbers.

### P4 — Reflect-on-result (post-write self-check)
- When a turn executed ≥1 **write** tool and is about to end: a **deterministic check of write-tool result payloads** for error/unconfirmed flags; if any failed/unconfirmed → force disclosure ("X সেভ হয়েছে, কিন্তু Y confirm হয়নি")। Optionally one bounded extra model round: "verify your writes actually landed; report failures honestly."
- Cheap, model-agnostic, catches the "claimed success but the tool errored" class the ledger check alone can miss. **Env:** `AGENT_REFLECT_GATE`.

---

## 4. Proving parity (so it's real, not vibes)
- **Behaviour parity golden set** (`src/agent/lib/__tests__/behaviour-parity.test.ts` + fixtures): ~20 owner prompts (a data question, a ≥3-step task, a "remember X", a fabrication trap, an irreversible action) run through the turn engine against **Grok 4.20 / DeepSeek / Gemini** (mocked adapters), asserting the SAME disciplined trajectory: grounding tool bound, plan created, fabrication rejected, card emitted, write reflected. This is the trace-verification idea — it prevents any model from silently regressing, and is your evidence that the layer works across models.
- Optional (high-stakes only, gated): 2-sample self-consistency for money/irreversible decisions → agree or escalate to `opus-gate`. Adds cost; keep off by default.

---

## 5. Rollout (mirrors your existing state-router canary pattern)
Each pillar ships behind its own `AGENT_*` env flag with `off | shadow | on | canaryPct`, exactly like `AGENT_STATE_ROUTER`. **Shadow mode** logs "what the gate WOULD have done" without changing behaviour, so you see impact before enforcing. Order = lowest-risk-first:

| Phase | Pillars | Risk | Why first |
|---|---|---|---|
| **BP1** | Constitution + re-inject + compaction guard (P6/P5) | Low | Pure prompt/context plumbing; biggest felt uplift |
| **BP2** | Ground-before-answer + Plan-first (P2/P3) | Med | Reuses proven requirement-contract binding |
| **BP3** | Factual-claim gate + Reflect-on-write (P1/P4) | Med | Extends the proven verifier retry |
| **BP4** | Parity golden-set + canary tune | Low | Proof + safe ramp to 100% |

Every phase: its own branch + pre-phase tag, typecheck+build+vitest green, `git diff --stat` scope check (only `src/agent/**` touched), and a before/after demo on the Vercel preview with Grok as head. One phase per session.

---

## 6. What this will and won't change (honest)
- **Will:** every model (Grok included) stops answering from memory on data questions, plans complex work first, cannot fabricate stats or successes, checks its own writes, and holds the same rules deep into long sessions — the "senior, trustworthy, grounded" feel, independent of model.
- **Won't:** make Grok reason as deeply as Opus on genuinely hard problems. That gap stays; your light/heavy routing (Grok default, Gemini/Opus for hard) is the right lever there — untouched by this plan.

---

## 7. Files this touches (all `src/agent/`, additive, env-gated)
`system-prompt.ts` (Constitution module + lint), `conversation-compact.ts` (rule preservation), `models/run-owner-turn.ts` (re-injection + gate bindings), `owner-turn-requirements.ts` (grounding + plan classifiers), `claim-verifier.ts` + new `factual-claim-gate.ts` (fact gate), new reflect check, `config.ts` (new knobs), new `__tests__/behaviour-parity.test.ts`. **No ERP code, no `/api/agent/*`, no DB migration.**

---

*Plan only — nothing implemented yet. On your confirm, I start with BP1 (Constitution + anti-drift) on a `agent-behaviour-parity-bp1` branch, shadow-mode first, with a Grok-head before/after demo.*
