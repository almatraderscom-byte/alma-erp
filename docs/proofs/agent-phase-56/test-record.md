# Phase 56 proof — personal + business operating system (service adapters)

Date: 2026-07-17 (Asia/Dhaka) · Branch: claude/agent-roadmap-phases-2a10b1

## What shipped

- Prisma (additive migration 20260717010000_phase56_add_service_connections): `agent_service_connections` — per-service status (disconnected|sandbox|connected|paused|revoked), least-privilege grantedOps, readiness (sandbox_pending|sandbox_passed|ready), retention window, delete-data timestamp
- `integrations/service-adapter.ts` — THE adapter contract: capability discovery, scopes, health, read/stage/write map, risk class, engine idempotency, proof, undo, rate limits, data class, sandbox suite, disconnect; `assertAdapterContract` CI-fails any gap
- `integrations/service-registry.ts` — connection lifecycle; **ready is reachable ONLY through a passing sandbox** and an explicit owner promotion; runtime `assertOpAllowed` gate (live + granted, fail closed)
- `personal-os.ts` — 'personal-records' adapter (bills/reminders): reads, private reminder drafts, create/cancel reminder as verified exactly-once effects with re-read proof + undo pair
- `business-os.ts` — 'erp-orders' adapter: order reads, customer-update DRAFTS (no send op exists — sending remains the R3 point-of-risk flow), add/remove order note as verified effects
- OS tool surfaces (`personal-os-tools.ts` / `business-os-tools.ts`) defined + gated; pool/group promotion deliberately deferred to the Phase 57 ladder

## Exit gates

- ≥1 personal AND ≥1 business adapter complete plan → guard → effect → verify → resume: **PASS** (policy core authorizes, signed envelope, executeEffect exactly-once, record re-read proof, replay on resume; ledger completeness verified)
- Cross-service tasks keep ONE focus and never leak scope: **PASS** (same conversation/turn binding on both effects; distinct idempotency identities; cross-scope ops refused)
- Owner can inspect, pause, revoke, delete retained data: **PASS** (lifecycle tests incl. fail-closed store outage)
- No adapter ready from connection alone: **PASS** (connect → refused; sandbox pass → still refused; explicit ready → allowed; least-privilege refusals)
- Regression: **2083/2083 vitest**, tsc clean
- Chrome proof: DEFERRED (deploys disabled; final live verify shows the private draft/sandbox workflow only)
