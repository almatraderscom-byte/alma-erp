# Long-job continuation fix — live evidence ledger (PR #850)

Incident under repair: production 2026-08-24 — one inventory-report request →
plan-driver auto-continue ran to hop 12, ~98k tokens, no report; one hop was
fully blocked by `OWNER_INPUT_BINDING_BLOCKER` yet the next hop was scheduled;
ended in deadline salvage "Boss, "continue" বললে ঠিক এখান থেকে কাজ চালিয়ে যাব".

Prod DB carries the scars: stale `self_continue_hops:*` KV rows at 11 and 10
from the runaways (read 2026-08-24 via Supabase REST).

## What is verified where

| Fix | Unit/regression | Live |
|-----|-----------------|------|
| 1. Hop brake (dry hops, guard halt, reap guard) | self-continue.test.ts, reap-guard-blocker.test.ts, run-owner-turn-continuation-routing.test.ts (real halt KV write) | this ledger |
| 2. Durable server-side resume (salvage) | run-owner-turn-salvage-resume.test.ts + self-continue deadline/deferral tests | this ledger |
| 3. Worker lane for report-class turns | long-turn-lane.test.ts | this ledger |

Note on pre-merge live scope: the VPS worker executes turns by calling back the
PRODUCTION chat route, so until this PR merges, hop turns run on old prod code.
Pre-merge live runs therefore prove the preview-side behavior (classification,
enqueue, tail, salvage scheduling, brake state writes) with an emergency KV
brake armed (`self_continue_hops` forced to 12 caps a prod chain immediately).
The full same-prompt end-to-end re-run is repeated post-merge on production
code.

## Evidence

### Run 1 — the incident-class prompt on the PR preview (2026-08-24 17:48Z)

Deployment `a6047b1b` (preview alias), internal lane (executes inline on
PREVIEW code — brakes + salvage-resume live), prompt exactly the incident
class: `আজকের inventory এর সম্পূর্ণ report বানিয়ে দাও`.

Full SSE transcript: `preview-internal-lane-report-run.log`. Outcome:

- **Finished in ONE turn**: 39.6s, 7 API rounds, 4 successful tool calls
  (`get_inventory_status` ×2, `get_reorder_suggestions`, `find_tool`),
  $0.037, `needContinue:false` on the terminal `done`.
- Structured Bangla report persisted (message `85454cfc…`: SKU count, stock
  value, low/out-of-stock, reorder — `##` sections).
- `referencesActive:true` on the done event and a verified reference in the
  payload — the stream contract held on the new lane.
- Post-run DB: **zero** `self_continue_*` KV rows for the conversation
  (`ea89edca…`), turn `done` — no hops, no salvage, no runaway.

Contrast with the production incident (old code, same prompt class): 12 hops,
~98k tokens, no report, deadline salvage. Prod KV still carries stale
`self_continue_hops` rows at 11 and 10 from those runaways.

### Pending

- Owner-web worker-lane run (classifier → BullMQ handoff → SSE tail) needs one
  owner login on the branch preview alias; staged in the owner's Chrome.
- Post-merge production re-run of the same prompt (worker slices then execute
  on merged code).
