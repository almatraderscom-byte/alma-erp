# Phase 7 Report — Polish + Production Hardening

**Branch:** `agent-phase-7`  
**Tag (pre-flight):** `pre-agent-phase-7`  
**Date:** 2026-06-12  
**Commit:** `feat(agent): Phase 7 — sentry, watchdog, backups, resilience hardening`

---

## Verification Checklist

| # | Check | Status |
|---|-------|--------|
| 1 | Sentry: agent-tagged events on tool/Anthropic/chat errors (app) + worker unhandled rejections | ✅ PASS |
| 2 | `agent_heartbeats` table + worker 60s beats (telegram-bot, schedulers, queue-consumer) | ✅ PASS |
| 3 | Vercel cron `/api/assistant/internal/watchdog` every 10 min; stale >5 min → Tier 2 ntfy | ✅ PASS |
| 4 | Worker pings `/api/assistant/internal/health` every 5 min; failure → direct ntfy CRITICAL | ✅ PASS |
| 5 | pm2 `ecosystem.config.cjs` with `max_memory_restart: 512M`; SETUP documents startup/save | ✅ PASS |
| 6 | Nightly `pg_dump` script + 14-day rotation + Hermes archive path | ✅ PASS |
| 7 | Meta Graph API: timeout + 1 retry (`resilientFetch`) | ✅ PASS |
| 8 | FB post + job-result idempotency (no double-post / double message) | ✅ PASS |
| 9 | Staff dispatch: only `approved` tasks; re-run skips `sent` | ✅ PASS |
| 10 | Confirm-card expiry on **reject** (30 min) + approve (existing) | ✅ PASS |
| 11 | Chat rate limit 30 req/min per session; Telegram flood guard 12/min | ✅ PASS |
| 12 | Secrets grep: no leaked API keys in repo | ✅ PASS |
| 13 | `scripts/test-staff-safe-tools.mjs` — finance/salah/memory excluded | ✅ PASS |
| 14 | Worker log hygiene: `log-safe.mjs` redacts amounts; Telegram logs message length only | ✅ PASS |
| 15 | UX: sidebar/thread loading, empty states, retry, conversation pagination, quota Bangla | ✅ PASS |
| 16 | `npm run type-check` + `npm run build` | ✅ PASS |

---

## Part 1 — Sentry

- Reuses existing `@sentry/nextjs` project; agent events tagged `category: agent` / `module: agent`.
- **App:** `src/agent/lib/sentry.ts` → `captureAgentError` on tool failures, Anthropic errors (with `requestId`, never API key).
- **Worker:** `worker/src/sentry.mjs` (`@sentry/node`), init on boot, `unhandledRejection` handler.
- **Env:** `SENTRY_DSN` on Vercel + VPS worker (documented in `.env.example`).

---

## Part 2 — Watchdog & Heartbeats

| Component | Path / behavior |
|-----------|-----------------|
| Migration | `prisma/migrations/20260612120000_agent_phase7_heartbeats` |
| Model | `AgentHeartbeat` (`service`, `lastBeatAt`) |
| Worker writer | `worker/src/heartbeat.mjs` — POST every 60s |
| Ingest | `POST /api/assistant/internal/heartbeat` |
| App liveness | `GET /api/assistant/internal/health` (internal token) |
| Watchdog cron | `GET /api/assistant/internal/watchdog` — `vercel.json` `*/10 * * * *` |
| Worker → app ping | `worker/src/health-ping.mjs` — every 5 min, ntfy CRITICAL on failure |

**Stale threshold:** 5 minutes (`HEARTBEAT_STALE_MS`).

---

## Part 3 — Backups

### Supabase automated backups / PITR

- Confirm in Supabase Dashboard → **Project Settings → Database → Backups**.
- **Free tier:** daily backups, limited retention (no PITR).
- **Pro tier:** daily backups + **Point-in-Time Recovery** (PITR) — verify enabled before relying on it for finance data.
- Agent Phase 7 does **not** change Supabase tier; owner should confirm tier and PITR status manually.

### VPS nightly `pg_dump`

- Script: `scripts/agent-backup.sh`
- Output: `/opt/agent-backups/agent_finance_YYYYMMDD_HHMMSS.sql.gz`
- Retention: 14 days
- Cron (documented in `worker/SETUP.md` §8b): `0 3 * * *` UTC
- Failure → Tier 1 ntfy (`NTFY_TOPIC_GENERAL`)

**Restore to scratch schema:**

```bash
gunzip -c /opt/agent-backups/agent_finance_YYYYMMDD_HHMMSS.sql.gz | psql "$SCRATCH_DATABASE_URL"
```

### Hermes SQLite archive

- One-time copy to `/opt/agent-backups/hermes-final/hermes.db` when `HERMES_DB_PATH` exists.
- Hermes decommission **not** in this phase — owner instruction only.

---

## Part 4 — Resilience Audit

| Area | Fix |
|------|-----|
| Anthropic errors | Bangla messages + quota → Tier 1 notify (`src/agent/lib/anthropic-errors.ts`) |
| Meta Graph | `resilientFetch` 30s timeout, 1 retry |
| FB post | `updateMany` claim `pending` → prevents concurrent double-post |
| Queue jobs | `job-result` returns `idempotent: true` if already executed/failed |
| Staff dispatch | Only `status=approved` tasks; marks `sent` after dispatch |
| Reject expiry | `isPendingActionExpired()` — 410 + Bangla message |
| Rate limits | `checkAssistantChatRateLimit` 30/min; Telegram `TELEGRAM_AGENT_FLOOD_PER_MIN` default 12 |
| Internal auth | `timingSafeEqual` on all internal routes (existing + new) |
| Staff registry test | `node scripts/test-staff-safe-tools.mjs` |

---

## Part 5 — UX Polish

- **AgentSidebar:** loading spinner, error + retry, paginated conversations (`?paginated=true&cursor=`), “আরও দেখুন”.
- **AgentApp:** conversation load state, retry on failure, quota/rate-limit Bangla in stream errors.
- Empty states: “কোনো কথোপকথন নেই — নতুন চ্যাট শুরু করুন”.

---

## Part 6 — Verification (executed 2026-06-12)

| Step | Result |
|------|--------|
| Vercel production deploy (`agent-phase-7` via CLI) | ✅ `dpl_2YC1RydrxahhFMripSznzuK3THca` — health/heartbeat/watchdog routes live |
| VPS `git checkout agent-phase-7` + `prisma migrate deploy` | ✅ migration `20260612120000_agent_phase7_heartbeats` applied (38 total) |
| `pm2 restart agent-worker` + `pm2 save` | ✅ online; `pm2-root` systemd unit **enabled** |
| Backup cron `0 3 * * *` | ✅ installed; manual run → `/opt/agent-backups/agent_finance_20260611_213925.sql.gz` (20K) |
| Hermes archive | ✅ `/opt/agent-backups/hermes-final/hermes.db` |
| `node scripts/test-staff-safe-tools.mjs` on VPS | ✅ PASS (10 tools) |
| Watchdog stale simulation (backdate heartbeats 10 min) | ✅ `stale: [telegram-bot, schedulers, queue-consumer]` + Tier 2 notify fired |
| Watchdog recovery (fresh heartbeat) | ✅ `ok: true`, `stale: []` |
| Internal health from VPS | ✅ HTTP 200 `{"ok":true,"db":true}` |

**Remaining owner-only checks:** live `pm2 stop` → wait 10 min for real ntfy alert; Sentry dashboard filter `category:agent` after a forced error; optional VPS reboot drill.

---

## OPERATIONS RUNBOOK (Owner)

### What each alert means

| Alert | Meaning | Action |
|-------|---------|--------|
| **Worker down** (Tier 2, urgent) | A worker heartbeat (`telegram-bot`, `schedulers`, or `queue-consumer`) silent >5 min | SSH VPS → `pm2 logs agent-worker --lines 50` → restart (below) |
| **App down** (ntfy CRITICAL from worker) | Worker cannot reach Vercel `/api/assistant/internal/health` | Check Vercel deployment status, `AGENT_ENABLED`, DB connectivity |
| **Anthropic quota exhausted** (Tier 1) | API credits/rate limit hit | Top up Anthropic billing; agent chat will show Bangla quota message |
| **Agent backup failed** (Tier 1) | Nightly `pg_dump` failed | Check `DATABASE_URL` in worker `.env`, disk space on `/opt/agent-backups/`, `backup.log` |

### Restart the worker (one command)

```bash
cd /opt/alma-erp/worker && pm2 restart agent-worker
```

Full restart from ecosystem file:

```bash
cd /opt/alma-erp/worker && pm2 start ecosystem.config.cjs
```

### Kill switches

| Variable | Where | Effect |
|----------|-------|--------|
| `AGENT_ENABLED=false` | Vercel env | All `/api/assistant/*` routes return 503 — web UI + internal API off |
| `SCHEDULERS_ENABLED=false` | VPS `worker/.env` | Morning/evening/salah/messenger schedulers skip runs (worker still polls queue + Telegram) |

After changing env: Vercel redeploy for app; `pm2 restart agent-worker` on VPS.

### Where backups live

- **Agent + finance tables:** `/opt/agent-backups/agent_finance_*.sql.gz` (14-day rotation)
- **Hermes SQLite archive:** `/opt/agent-backups/hermes-final/hermes.db`
- **Supabase:** dashboard backups / PITR per project tier

### Useful commands

```bash
pm2 status
pm2 logs agent-worker --lines 100
node scripts/test-staff-safe-tools.mjs
curl -H "Authorization: Bearer $AGENT_INTERNAL_TOKEN" https://alma-erp-six.vercel.app/api/assistant/internal/health
```

### Sentry

- Dashboard: same ERP project; filter `category:agent` or tag `module:agent`.
- Worker + app share `SENTRY_DSN`.

---

## Files Created / Modified (agent scope)

**New:** migration heartbeats, internal health/heartbeat/watchdog routes, agent sentry/notify/retry/constants, worker sentry/heartbeat/health-ping/log-safe/fetch-retry, `ecosystem.config.cjs`, `scripts/agent-backup.sh`, `scripts/test-staff-safe-tools.mjs`, `src/lib/assistant-rate-limit.ts`

**Updated:** `core.ts`, chat/reject/approve/conversations/job-result routes, `meta.ts`, `AgentApp.tsx`, `AgentSidebar.tsx`, `vercel.json`, `worker/index.mjs`, `telegram/index.mjs`, `staff/dispatch.mjs`, `SETUP.md`, `.env.example`, `capture.ts`, `registry.ts`

---

**Do not merge to `main` until owner completes Part 6 manual verification on production.**
