# Phase 61 — Production truth & release identity

Branch: `agent-phase-61` · Tag: `pre-agent-phase-61`
Goal: make it impossible to confuse **merged → deployed → configured → reachable → enabled/used → outcome**.

## What was built

1. **`src/agent/lib/production-truth.ts` (new)** — one read-only module that answers the six questions per capability from LIVE signals (real DB records + flags), never from "the env var exists". Two exports:
   - `getReleaseIdentity()` — app commit SHA (via shared `src/lib/runtime-build.ts`), Vercel env/branch/deployment, the real Prisma migration head (`_prisma_migrations` read), and worker/service liveness from `agent_heartbeats`. `shaProven` is true only when the exact commit is known; worker SHA is honestly `unknown` (workers don't stamp it yet).
   - `getProductionTruth()` — a 14-row feature truth matrix. Each row: `implemented, deployed, configured, reachable, effectiveMode, lastRealUse, use7d, lastVerifiedOutcome, blocker`.
2. **`effectiveMode` has six honest states** — `off | shadow | unwired | broken | unused | live | unknown`. Only `live` renders green. Probes fail-open to `unknown`; **`unknown` is never a pass.**
3. **Health endpoint** — `GET /api/assistant/internal/health?truth=true` now returns the full truth object (owner-token gated). Additive + gated, so the frequent VPS liveness ping stays byte-identical.
4. **Owner monitor view** — `GraphHealthPanel` (`/agent?monitor=graph`) now renders the release-identity header + colour-coded feature matrix above the existing rollout panel. No change to `page.tsx` needed (reuses the existing owner-gated route).

## Feature rows and the live signal each reads

| Row | Live signal | Distinguishes |
|---|---|---|
| langgraph | `__route__` tool events w/ `turnGraph` + `agent_graph_rollout_stage` | shadow vs live vs unused |
| continuity | `agent_conversation_focuses` created 7d | live vs unused (coverage gap) |
| interaction | `__interaction__` tool events 7d | live vs unused vs off |
| effect_engine | `AGENT_EFFECT_ENGINE` + `agent_action_runs` | off vs unused vs live |
| durable_queue | `workflow_runs kind=durable_task` | **unwired** (no caller) vs live |
| autonomy_ladder | `autonomy_rollout:*` KV | **unwired** (no guard call-site) |
| service_adapters | `agent_service_connections` | **unwired** (no bootstrap) |
| growth_brief | `agent_growth_briefs status=approved` | **off/red when absent** |
| experiments | `agent_growth_experiments` | off vs unused vs live |
| capi | pixel/dataset+token secret + `agent_marketing_events source=server` | off vs unused vs live |
| instagram | (provider) | **unknown** — owner Meta UI needed |
| browser_runner | `live_browser_devices` paired/lastSeen | unwired vs unused vs live |
| heartbeat | `agent_heartbeats` age ≤30m | live vs broken vs unused |
| content_engine | approved brief gate + content duty runs 7d | off (gated) vs unused vs live |

These map 1:1 to the audit's GAP-03/05/06/08/09/10 dead paths, so the panel now *shows* those gaps instead of hiding them.

## Definition-of-Done status (honest)

| Level | State | Evidence |
|---|---|---|
| 1. Implemented | ✅ | module + endpoint + panel + tests on `agent-phase-61` |
| 2. Deployed | ⏳ owner | needs branch push → Vercel preview SHA, then owner merge/deploy |
| 3. Reachable | ✅ (self) | endpoint + panel import chain compiles; `tsc` clean |
| 4. Enabled/used | ⏳ owner | live route needs owner login on the preview |
| 5. Outcome | ⏳ owner | real-data matrix visible after owner opens the preview |

`Implemented` is **not** reported as `Live`.

## Self-verification done at Claude's end

- **Unit tests 10/10** (`production-truth.test.ts`): nothing green when DB empty; missing Growth Brief → `off` + blocker; durable_queue/service_adapters/autonomy_ladder → `unwired`; Instagram → `unknown`; a throwing probe → `unknown` (never green); approved brief → `live`; SHA proven from commit; summary sums to total. See `docs/proofs/agent-phase-61/01-unit-tests.txt`.
- **Fail-open live run** against the real prod DB (local creds are stale → every query threw): all 14 rows degraded to `unknown`/`unused`, **zero green**. This exercised the exit gate end-to-end. See `docs/proofs/agent-phase-61/02-failopen-live-run.txt`.
- **Typecheck**: `tsc --noEmit` = 0 errors project-wide after `prisma generate` (the pre-existing 67 errors were a stale local Prisma client, unrelated). See `03-typecheck.txt`.
- **Non-breaking**: health `?truth=true` is additive + gated; panel section is additive; no existing export changed.

## Exit gate check

- ✅ Preview page will show its own exact SHA and distinguishes shadow/off/unwired/broken/unused/live/unknown.
- ✅ A deliberately missing config (no Growth Brief, dead DB) stays red/unknown — proven, never green.
- ⏳ Production verification (exact prod SHA) comes only after owner merge/deploy.

## Owner-gated follow-ups

- Push `agent-phase-61` → Vercel preview → owner logs in → capture the live matrix screenshot into `docs/proofs/agent-phase-61/`.
- Optional: have the worker stamp its own release SHA so worker identity stops being `unknown`.
