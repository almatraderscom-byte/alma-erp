# Phase 53 proof — transactional effect engine, immutable ledger, compensation

Date: 2026-07-17 (Asia/Dhaka) · Branch: claude/agent-roadmap-phases-2a10b1

## What shipped

- Prisma (additive migration 20260717000000_phase53_add_effect_engine): `agent_action_runs` (exactly-once unit, optimistic stateVersion), `agent_effect_ledger` (append-only, gapless per-run seq), `agent_effect_outbox` (transactional dispatch queue)
- `effects/action-run.ts` — full state machine (proposed→policy_checked→awaiting_approval|claimed→executing→verifying→succeeded + denied/expired/failed_retryable/failed_final/unknown_effect/compensating/compensated) with `executeEffect()`: same idempotency key ⇒ same run; executing commits BEFORE dispatch; crash-after-dispatch reconciles, never blind-retries
- `effects/effect-ledger.ts` — append-only writer inside the state transaction (ledger failure aborts the write) + completeness verifier (succeeded requires a proof row)
- `effects/outbox.ts` + `worker/src/effect-worker.mjs` — leases (CAS), deterministic backoff, dead-letter with ledger evidence; worker loop gated by AGENT_EFFECT_ENGINE (default OFF)
- `effects/reconciler.ts` — provider-state probes; stale executing → unknown → verify/retry/park
- `effects/compensation.ts` — undo is a NEW enveloped effect; original goes compensating→compensated only on verified undo success
- `autonomy-ledger.ts` — durable ledger is now the source of truth; the 100-entry KV ring demoted to derived cache
- registry.ts — write tools route through executeEffect when AGENT_EFFECT_ENGINE=true (default OFF per readiness doctrine)

## Exit gates

- Crash at every state boundary + 20 repeats ⇒ exactly one external effect: **PASS** (vitest, seeded states proposed/policy_checked/claimed/executing + intent-tx rollback)
- Timeout-after-success reconciled, not duplicated: **PASS** (1 send, succeeded via probe)
- Ledger failure blocks the write (nothing dispatched): **PASS**
- No success without proof (verify=null keeps run in verifying): **PASS**
- Ledger completeness (gapless seq + final-state transition + proof): **PASS**
- Duplicate workers cannot hold the same lease; dead-letter is ledgered: **PASS** (node --test 9/9)
- Full regression: **2018/2018 vitest + 9/9 node --test**, tsc clean, prisma validate clean
- Chrome proof: DEFERRED (deploys disabled by owner instruction; final live verify will show one effect, retry/reconnect, one receipt, one ledger chain, guarded compensation)
