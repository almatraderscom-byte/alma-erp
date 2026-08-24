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

(filled during the live runs)
