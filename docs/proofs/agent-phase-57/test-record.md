# Phase 57 proof — staged autonomy ladder + owner control centre

Date: 2026-07-17 (Asia/Dhaka) · Branch: claude/agent-roadmap-phases-2a10b1

## What shipped

- `autonomy-readiness.ts` — evidence-based readiness gates: min samples, correctness ≥96%, recovery ≥95%, proof ≥95%, ZERO critical guard failures, owner-correction ≤10%, cost budget, tested compensation; evidence resets on any policy/implementation/version change
- `autonomy-rollout.ts` — the per-task-class ladder: off → shadow → suggest → draft → auto_r1 → bounded_r2, ONE class + ONE rung per promotion with explicit owner note; tier ceilings (R3 ⇒ draft max, R4 ⇒ shadow max — auto is unreachable forever); control dimensions (daily count, money cap, quiet hours, canary %, expiry, notify); automatic one-rung rollback + evidence reset on failure threshold or critical failure; `effectiveStage` reads FRESH state each decision (revoke/pause applies before the next execution) and degrades on expiry/quiet-hours
- controls route — GET ?section=autonomy_rollout (ladder + service connections) and POST actions: promote/demote/pause per class, service pause/resume/revoke/delete-data, clear_quarantine; there is NO promote-everything endpoint
- `AutonomyControlCenter.tsx` — owner UI: one card per task class with plain-Bangla "যা হবে / যা হবে না" examples per rung, promote/pause buttons, live limits, and the service-connection panel; wired into AgentControlCenter + monitor exports

## Exit gates

- No global "auto everything" switch: **PASS** (API is per-class only; test asserts no bulk/global export; UI has no such button)
- Plain Bangla will/won't examples: **PASS** (STAGE_EXAMPLES rendered per rung)
- Revoke/pause effective before the next tool execution: **PASS** (uncached effectiveStage read; demote-to-off visible immediately)
- Promotion by evidence only: **PASS** (shadow free; every later rung blocked without passing evidence; rungs cannot be skipped; promotion resets evidence for the next rung)
- Automatic rollback on forced failure: **PASS** (threshold + critical paths, evidence reset)
- Regression: **2100/2100 vitest**, tsc clean
- Chrome proof: DEFERRED (final live verify will promote one R1 class shadow→draft→bounded auto and trigger a forced rollback)
