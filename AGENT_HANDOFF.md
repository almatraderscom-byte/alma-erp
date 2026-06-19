# ALMA Agent — Handoff Note

_Last updated: 2026-06-20 (session 2). Owner: Maruf (non-engineer). Read this first in a fresh chat to continue without losing context._

---

## How to resume (paste this into a new chat)

> Read `/Users/marufbillah/alma-erp/AGENT_HANDOFF.md` and continue from there.

Worktree/branch for all current work:
- **Branch:** `agent-mkt-delegate`
- **Worktree:** `/tmp/alma-mkt-delegate` (temporary — if gone, recreate from the branch)
- **PR:** #37 — https://github.com/almatraderscom-byte/alma-erp/pull/37
- **Main repo:** `/Users/marufbillah/alma-erp`

---

## ✅ DONE — **MERGED TO PRODUCTION** (PR #37, merge commit `3a476e7`, 2026-06-20)

> All three items below are now live on `main` / production (alma-erp-six.vercel.app). Vercel auto-deploys main.


### 3. Per-model loading animation + card error fix — commit `f2f0d5c`
- **Per-model loading identity:** server now emits a `model_info` event at turn start (`runOwnerTurn` in `run-owner-turn.ts`); the live thinking indicator shows the matching animation — **Sonnet = Claude sparkle, DeepSeek = blue data dots, Qwen = orb** — plus a label ("🧠 Sonnet ভাবছে" / "⚡ DeepSeek উত্তর দিচ্ছে"). Before, the indicator was hard-coded to the Claude variant (AgentThread.tsx line ~522), so the owner couldn't tell which model ran.
  - New event type in `core.ts` AgentEvent union; client handling + `streamVariant` state in `AgentApp.tsx`; prop threaded into `AgentThread.tsx`.
  - The 3 animations already existed in `AgentThinkingIndicator.tsx` (`ModelSpinner`); this commit just wires them to the live turn.
- **Card approve/reject error fix:** approve & reject share the same guards (not_found / already_resolved / expired). A stale card made BOTH buttons throw a red "সমস্যা" toast. Now those terminal states settle the card with a calm grey note (`AgentConfirmCard.tsx`, new `settled` phase + `TERMINAL_NOTES`). Reject `maxDuration` raised 60→120 (sync Sonnet answer could 504 on cold start).
  - **Honest caveat:** the exact error text the owner saw was never captured, so root cause isn't 100% confirmed. This covers all known shared-guard causes + the timeout case. **If the error still appears, get the exact toast text** (it now shows the real server code) to pin it down.
- **Known limitation:** DeepSeek/Qwen don't emit a "thinking" text trace (only Sonnet does), so the thought box stays empty on cheap turns — the animation + label is how you tell them apart.

### 1. Delegation approval loop fixes — commit `25a6dcb`
- HTTP error after **Approve** fixed (approve route `maxDuration` 30→120; was Vercel 504).
- iPhone confirm card responsiveness fixed (word-break, flex-wrap buttons).
- Sonnet now **WAITS** after delegating — doesn't also write the answer (was doubling cost).
- **Reject → Sonnet answers the task directly.** So owner decides on the card: **Approve = cheap worker does it / Reject = Sonnet does it now.**

### 2. Cheap triage head (Phase 1 cost reduction) — commit `c5ef661`
- Before every owner message, a near-free triage (DeepSeek) decides who answers:
  - **light/routine** (sales status, who's present, stock/order counts, casual, simple CS) → cheap head **DeepSeek** (~30–40× cheaper).
  - **heavy/sensitive** (money, finance write/edit/delete, payroll/salary, staff discipline, planning/strategy, real marketing work, anything ambiguous) → **Sonnet** as before.
- **Fail-heavy safety:** any error / missing key / personal mode / ALMA_TRADING / dangerous keyword (delete, বেতন, বোনাস, ধার, refund…) → Sonnet, no triage call.
- All money-moving actions still go through the **owner approval card** — a misroute can't move money.
- Kill switch: `ENABLE_CHEAP_HEAD` (default ON). Models swappable via `CHEAP_HEAD_MODEL_ID` / `CHEAP_HEAD_TRIAGE_MODEL_ID` — no code change.
- New file: `src/agent/lib/models/head-router.ts`. Wiring in `src/agent/lib/models/run-owner-turn.ts`.

**Verify status:** `tsc` ✅ · `eslint` ✅ · `npm run build` ✅ (exit 0). Only agent files touched, no ERP code.

---

## 🟡 RUNNING / WATCH ON PRODUCTION

- **Merged & deploying to production.** Watch on the live app (alma-erp-six.vercel.app):
  - Routine questions (today's sales, who's present) → animation = **blue dots (DeepSeek)**.
  - Heavy ones (finance entry, salary) → Sonnet + approval card; animation = **coral sparkle (Sonnet)**.
  - Delegation card: **Approve** (worker) vs **Reject** (Sonnet answers) — confirm no error toast.
  - Old/stale card → calm grey "আগেই প্রসেস হয়ে গেছে" note, not a red error.
  - **If any card STILL errors: screenshot the exact toast text** for the next session — it now shows the real server code.
- Kill switch if anything misbehaves: set env `ENABLE_CHEAP_HEAD=false` → everything goes back to 100% Sonnet, no redeploy of code needed.

---

## ⏳ PENDING / NEXT (discussed, NOT yet authorized to build)

- **Phase 2:** Move ERP/staff-manager work to DeepSeek, with **Sonnet reviewing finance** before final. (Owner idea: "deepseek erp ba stuff manager korbe, sonnet review kore final korbe.")
- **Phase 3:** As the office grows (more than 2–5 staff), scale Sonnet's role back up where needed.

---

## Key facts the next session must know

- **Goal driving all this:** owner is cost-fatigued. Last 30 days = 100% Sonnet (nothing to measure). Make Sonnet do **less**; cheap models do routine + background; Sonnet stays as **head + reviewer for critical**.
- **Hard rules (CLAUDE.md):** never touch live ERP code outside scope; never touch `/api/agent/*`; agent code only under `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`; `AGENT_ENABLED` kill switch; additive DB migrations only; branch `agent-phase-N` + tag before each phase; never merge/deploy to production without owner OK.
- **Owner authorized Claude to merge agent PRs to main** after verifying green build (MEMORY.md overrides CLAUDE.md) — but only once owner has tested the behavior change.
- **Flag convention:** `process.env.X !== 'false'` → unset/empty = ON (production env values are empty strings).
- **Model registry (per M tokens):** Sonnet 4.6 `claude-sonnet-4-6` ($3/$15, default) · DeepSeek V4 Flash `or-deepseek-v4-flash` ($0.09/$0.18, owner's cheap pick) · Haiku 4.5 ($1/$5) · Gemini 3.1 Flash-Lite ($0.3/$1.2).
- **Two owner-turn paths:** `runAgentTurn` (core.ts, native Anthropic) vs `runAlternateProviderTurn` (run-owner-turn.ts, non-Anthropic adapter). Both load full DB history, both fully featured. The new triage router (`runOwnerTurn`) picks which one per turn.
- **gh auth token:** `security find-generic-password -s "gh:github.com" -w` (fallback `find-internet-password -s "github.com" -w`); export as `GH_TOKEN`.
- **Vercel:** Pro plan, region hnd1. `maxDuration` up to 300 on chat route; internal routes 120.

---

## Files changed (all on `agent-mkt-delegate`)

- `src/agent/lib/models/head-router.ts` (NEW — triage router)
- `src/agent/lib/models/run-owner-turn.ts` (triage wiring + delegation WAIT-gate + `model_info` emit + `modelVariant`)
- `src/agent/lib/core.ts` (delegation WAIT-gate, native path; `model_info` event type added to AgentEvent union)
- `src/agent/components/AgentConfirmCard.tsx` (delegation card + iPhone responsiveness + `settled` terminal state for stale cards)
- `src/agent/components/AgentThread.tsx` (poll after delegation reject; `streamVariant` prop → per-model animation)
- `src/agent/components/AgentApp.tsx` (handle `model_info` SSE event, `streamVariant` state)
- `src/agent/components/AgentThinkingIndicator.tsx` (already had the 3 `ModelSpinner` variants — now wired live)
- `src/agent/lib/system-prompt.ts` (STOP-after-delegating note)
- `src/app/api/assistant/actions/[id]/approve/route.ts` (maxDuration 120)
- `src/app/api/assistant/actions/[id]/reject/route.ts` (delegation reject → Sonnet answers directly; maxDuration 120)
