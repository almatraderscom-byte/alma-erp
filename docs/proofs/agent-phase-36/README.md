# Phase 36 proof — human-grade interaction layer (no model change)

- **Date:** 2026-07-17 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`
- **Gate:** `AGENT_INTERACTION_LAYER` off | shadow | on (unset → preview **on**, production **shadow**)

## What shipped

| Piece | File |
|---|---|
| Interaction state | `src/agent/lib/interaction-state.ts` — deterministic mode ladder (crisis > listen > teaching > decision/coaching > concise-status > work), emotion read (low/anxious/angry/positive/neutral), correction + repair detection, detail preference |
| Interaction policy | `src/agent/lib/interaction-policy.ts` — per-mode capability contract (listen/crisis strip tools + forbid work pivot; only work mode may pivot), ONE owner-address contract (`Boss`; Sir/স্যার detector), non-deception constant, **commitment ledger** (`checkCommitmentLedger`: announced future action ⇒ durable task/card/reminder/focus or fail) |
| Response planner | `src/agent/lib/response-planner.ts` — plan BEFORE wording (repair → acknowledge → answer → evidence → commitment, unneeded sections omitted), deterministic opener rotation (anti-repetition, zero randomness), Bangla per-turn directive with the uncertainty split (তথ্য/অনুমান/পরামর্শ) |
| Turn wiring | `run-owner-turn.ts` — state derived every turn, recorded on the route span (`extras.interaction`); directive injected when ON; post-reply ledger check → violation logged (`__interaction__` span) and, in live mode, the missing focus is CREATED so the promise becomes structurally true |
| Prompt | `system-prompt.ts` — explicit non-deception + promise rule beside the existing Boss hard rule (no contradictory address fragments exist — verified) |

## Exit gates

| Gate | Result |
|---|---|
| No unrelated work pivot in 100 listen-mode cases | ✅ **103 cases** (20 corpus + 90 synthetic − dedupe) → 0 pivots (`human-behaviour-replay.test.ts`) |
| ≥95% behaviour rubric, zero critical guardrail failures | ✅ **16/16 (100%)** deterministic contract checks — context carry-over, emotional appropriateness, no-pivot, verbosity, correction/repair, groundedness split, address, crisis; никогда a model grader |
| No announced future action without durable commitment | ✅ ledger pure-checked + live-mode auto-focus; violations traced per turn |
| One owner-address contract, no contradictions | ✅ `OWNER_ADDRESS='Boss'`, banned-address detector, prompt scan asserted in CI |
| Non-deception | ✅ prompt line + `NON_DECEPTION_NOTE` in every directive |
| Chrome proof: work, emotional/listen, correction, long-gap continuation | ✅ `interaction-scenarios.html` / `proof-01-interaction-scenarios.png` (+ crisis and decision-support) |
