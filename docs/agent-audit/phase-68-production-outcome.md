# Phase 68 — Production canary, outcome scorecard & legacy retirement gate

Branch: `agent-phase-68` (stacked) · Tag: `pre-agent-phase-68`
Goal: promote only proven task classes and prove the owner is receiving material benefit (closes GAP-14: no owner-benefit scorecard).

## Delivered + verified

1. **`owner-benefit-scorecard.ts` (new)** — the capstone that ties together every prior phase's evidence stream into one weekly owner view:
   - **Continuity** (Phase 62): scored turns, correct-binding rate, owner corrections, gate status — from `summarizeBindingOutcomes`.
   - **Autonomy** (Phase 64): active classes, duplicate/unapproved/unknown effects, guard coverage — from `computeSloSnapshot`.
   - **Effects** (Phase 61/65): 7-day effect count + verified success — from the feature truth matrix.
   - **Top blockers** — the honest "what's holding value back", straight from the Phase 61 truth matrix.
   - **Business outcome is always `unknown`** until real COD/refund/gross-profit data exists — ROI is never invented.
2. **`evaluateRollbackThresholds()` (pure)** — the roadmap's automatic rollback rules, deterministic: any duplicate / unapproved R3-R4 / cross-account / secret leak → **class OFF**; any unknown effect → **effect class off until reconciled**; graph disagreement >2% / wrong-focus >1% / owner-correction >2% → **return to prior rung**; independent proof <99% → **no promotion**; service auth/health failure → **service paused**.
3. **`evaluateLegacyRetirementGate()` (pure)** — the legacy owner-turn path may be removed **only** after 30 consecutive production days at the final graph stage with **no** rollback signal **and** owner approval. Until then it stays as the rollback path.
4. **Owner monitor render** — the scorecard now shows at `/agent?monitor=graph` above the feature truth matrix (correct-binding %, owner corrections, duplicate/unknown effects, live rollback actions, top blockers, and the honest "business outcome unknown").

## Self-verification

- **8-case test** on the deterministic core: clean → no rollback; each hard invariant → class off; unknown → off-until-reconciled; the exact quality-rate thresholds; proof <99% blocks promotion; service failure pauses; the 30-day/rollback/owner-approval retirement gate; and the scorecard never invents ROI.
- **Full agent suite 186 files / 2352 tests PASS**; `tsc --noEmit` 0 errors; scorecard renders (server component compiles into the panel import chain).

## The rollout order (owner-executed, after merge/deploy)

Per §7 — Claude cannot promote in production; this is the owner's staged path once the branches are merged:
1. Continuity/focus live on owner turns; full graph stays shadow.
2. Full-graph read-only canary: preview → 1% → 10% → 25% → 50% → 100%, only while real agreement ≥98%.
3. `erp-reporting` + `research-public`: shadow → suggest → eligible R0 auto.
4. One Phase 65 internal R1 class: shadow → suggest → draft → R1 canary (via `AGENT_EFFECT_ENGINE=canary`).
5. Marketing weekly loop (after the Phase 63 owner onboarding).
6. Personal/Business OS: one service/op at a time.
7. R2 only under narrow stored policy + caps + notification + proof + undo.
8. R3/R4 remain point-of-risk / owner-controlled.

## Definition-of-Done (honest)

| Item | Level |
|---|---|
| Owner-benefit scorecard + rollback thresholds + retirement gate | 1–3 ✅ self-verified |
| Real scorecard numbers (verified work up, intervention down) | ⏳ needs production traffic under the new wiring |
| Canary promotions | 0 — owner-executed after merge/deploy |

`Implemented` is not reported as `Live`. No promotion, spend, or external effect was performed.
