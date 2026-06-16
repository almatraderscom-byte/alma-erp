# ALMA ERP — Production Deploy Runbook

## Architecture (one page)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Vercel (Tokyo hnd1) — Next.js 14 App Router                              │
│  • 351 API routes, 51 UI pages                                           │
│  • Web UI, NextAuth, internal /api/assistant/* token-gated routes        │
│  • Vercel Crons: 10 (health/cleanup, payroll-accrual, watchdog every 5m) │
│  • Build gate: typecheck + lint + production build + smoke               │
└──────────────────────────────────────────────────────────────────────────┘
                ▲ Bearer AGENT_INTERNAL_TOKEN ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ VPS (31.97.237.40) — PM2 process `agent-worker`                          │
│  • BullMQ queues + Redis                                                 │
│  • 55 cron schedulers                                                    │
│  • Telegraf bot (long-poll mode)                                         │
│  • Heartbeat → Vercel every 60s                                          │
└──────────────────────────────────────────────────────────────────────────┘
                ▲                                          ▼
┌──────────────────────────┐               ┌─────────────────────────────────┐
│ Supabase (Postgres + RLS)│               │ Telegram, Meta, Twilio, ElevenLabs│
│ + pgvector + Storage     │               │ + Anthropic + Whisper + Resend    │
└──────────────────────────┘               └─────────────────────────────────┘
```

## Standard deploy: code change to Vercel + worker

1. **Local pre-flight (mandatory):**
   ```bash
   npm run type-check        # must exit 0
   npm run lint              # must exit 0 (warnings ok)
   ```
2. **Push to `main`** (or merge PR). GitHub Actions `production-deploy-gate.yml` runs:
   - `npm ci`
   - `node scripts/check-pending-migrations.mjs` (blocks if pending)
   - `npm run regression:gate` (typecheck → lint → build → authenticated smoke)
   - **Failing gate blocks the merge.**
3. **Vercel auto-deploys on `main`** after the gate passes. Build runs `prisma generate && next build`.
4. **Verify deploy:**
   ```bash
   curl https://alma-erp-six.vercel.app/api/health
   # expect: { "ok": true, ... "git_commit": "<NEW_SHA>" }
   ```
5. **Worker deploy** (only when `worker/src/**` changed):
   - From ERP UI: Staff Monitor → "Deploy Worker" button, OR
   - SSH:
     ```bash
     ssh root@31.97.237.40
     cd /opt/alma-erp && git pull origin main
     cd worker && npm ci --omit=dev
     pm2 restart agent-worker --update-env
     pm2 logs agent-worker --lines 50
     ```
6. **Verify worker:**
   ```bash
   ssh root@31.97.237.40 'pm2 jlist | jq -r ".[] | select(.name==\"agent-worker\") | .pm2_env.status"'
   # expect: online
   ```

## Migrations

- Additive only. Use `prisma/migrations/<timestamp>_<name>/migration.sql`.
- **Never** edit a migration that has been deployed.
- Apply manually for partial-unique indexes that Prisma can't model:
  ```bash
  ssh root@31.97.237.40 'set -a; source /opt/alma-erp/worker/.env; set +a; psql "$DATABASE_URL" -c "<sql>"'
  ```
- Then register the migration row:
  ```sql
  INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
  VALUES (gen_random_uuid()::text, 'manual-<name>', NOW(), '<timestamp>_<name>', NOW(), 1);
  ```

## Required environment (must be set on BOTH Vercel and VPS unless noted)

| Variable | Vercel | VPS | Notes |
|---|:-:|:-:|---|
| `DATABASE_URL` | ✅ pooler (6543) | ✅ direct (5432) | |
| `NEXTAUTH_SECRET` | ✅ | — | |
| `NEXTAUTH_URL` | ✅ | — | |
| `AGENT_INTERNAL_TOKEN` | ✅ | ✅ | Worker→Vercel auth |
| `CRON_SECRET` | ✅ | — | Vercel cron auth |
| `ALMA_AGENT_API_KEY` | ✅ | ✅ (Hermes) | Legacy `/api/agent/*` |
| `WEBSITE_ORDER_SECRET` | ✅ | — | almatraders.com → ERP |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | |
| `ANTHROPIC_API_KEY` | ✅ | — | Worker calls Vercel for AI |
| `OPENAI_API_KEY` | ✅ | ✅ | Whisper + embeddings |
| `GEMINI_API_KEY` | ✅ | — | |
| `RESEND_API_KEY` | ✅ | — | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | ✅ | ✅ | TWILIO_AUTH_TOKEN required on Vercel for webhook signature verification |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | ✅ | — | Webhook signature |
| `FB_PAGE_TOKEN_LIFESTYLE`, `FB_PAGE_TOKEN_ONLINESHOP` | ✅ | ✅ | CS sends |
| `META_PAGE_ACCESS_TOKEN` | ✅ | ✅ | Ad insights / page management |
| `ASSISTANT_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | — | ✅ | Telegraf long-poll |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | — | Trading-ERP bot webhook |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | — | ✅ | Custom voice TTS |
| `GOOGLE_TTS_CREDENTIALS` | — | ✅ | Salah Bangla TTS |
| `NTFY_TOPIC_GENERAL`, `NTFY_TOPIC_CRITICAL` | ✅ | ✅ | |
| `AGENT_ENABLED` | ✅ | ✅ | Kill switch |

The `/api/health` endpoint reports `env.ok: true` only when all required vars are present.

## Rollback

- **Vercel:** revert to previous deployment in dashboard (1 click).
- **Worker:** `cd /opt/alma-erp && git reset --hard <PREVIOUS_SHA> && pm2 restart agent-worker`.
- **Migrations:** there is no auto-rollback. Plan additive migrations only; manually craft a reverting migration if needed and treat as a forward deploy.

## Health & alerting

- `/api/health` — DB, GAS, env, storage, cron-configured. Checked from Vercel dashboard daily.
- `/api/assistant/internal/watchdog` — Vercel cron every 5 min; alerts owner Telegram if any of `telegram-bot`/`schedulers`/`queue-consumer` heartbeats are stale > 5 min.
- Sentry — every API route auto-captured via `instrumentation.ts` + `Sentry.captureRequestError`.
- ntfy critical topic (`alma-agent-crit`) for tier-2 alerts (e.g. trust API down, FB token expiring).

## Smoke verification after deploy (5 minutes)

```bash
# 1. App health
curl -s https://alma-erp-six.vercel.app/api/health | jq '.ok, .env.ok, .database.ok'
# Expect: true, true, true

# 2. Worker heartbeat (from VPS)
ssh root@31.97.237.40 "set -a; source /opt/alma-erp/worker/.env; set +a; \
  psql \"\$DATABASE_URL\" -tAc \"SELECT service, last_beat_at FROM agent_heartbeats ORDER BY last_beat_at DESC\""
# Expect: 4 rows including queue-consumer/schedulers/telegram-bot updated < 1 min ago

# 3. Worker process
ssh root@31.97.237.40 'pm2 jlist | jq -r ".[] | select(.name==\"agent-worker\") | .pm2_env.status"'
# Expect: online

# 4. Sentry — open dashboard, confirm no new burst of errors

# 5. Owner Telegram bot — send /start; should respond within 2s
```

If any step fails: rollback Vercel deployment, rollback worker, page owner.
