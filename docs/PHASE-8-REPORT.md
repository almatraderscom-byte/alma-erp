# Phase 8 Report — Cost Dashboard (Final Phase)

**Branch:** `agent-phase-8`  
**Tag (pre-flight):** `pre-agent-phase-8`  
**Date:** 2026-06-12  
**Commit:** `feat(agent): Phase 8 — cost dashboard, subscriptions, budgets, export`

---

## Verification Checklist

| # | Check | Status |
|---|-------|--------|
| 1 | Migration additive: `agent_cost_events`, `agent_subscriptions` | ✅ PASS |
| 2 | `logCost()` on: chat, embedding, whisper, TTS, image gen, Twilio | ✅ PASS |
| 3 | Backfill script idempotent (`scripts/backfill-cost-events.mjs`) | ✅ PASS |
| 4 | Subscriptions: CRUD API + `add_subscription` confirm card + renewal scheduler | ✅ PASS |
| 5 | Budgets in `agent_kv_settings` + hourly worker check (80%/100%) | ✅ PASS |
| 6 | Daily summary line: `আজকের AI খরচ: $X.XX` | ✅ PASS |
| 7 | Dashboard `/agent/costs`: cards, charts, subs, CSV UTF-8 BOM | ✅ PASS |
| 8 | `npm run type-check` + `npm run build` | ✅ PASS |
| 9 | `node scripts/test-staff-safe-tools.mjs` | ✅ PASS |

---

## Part 1 — Cost Event Logging

### Schema

`agent_cost_events`: provider, kind, units (JSONB), costUsd, conversationId, jobId, dedupKey (unique), occurredAt.

### Central helper

- App: `src/agent/lib/cost-events.ts` → `logCost()`
- Worker: `worker/src/cost-log.mjs` → POST `/api/assistant/internal/cost-event`
- Pricing: `src/agent/lib/pricing.ts`

### Instrumented call sites

| Site | Provider | Kind |
|------|----------|------|
| `src/agent/lib/core.ts` | anthropic | chat |
| `src/agent/lib/embeddings.ts` | openai | embedding |
| `src/app/api/assistant/transcribe` + internal | openai | transcribe |
| `src/app/api/assistant/tts` | google_tts | tts |
| `worker/src/tts.mjs` | google_tts | tts |
| `worker/src/index.mjs` image-gen | gemini | image |
| `worker/src/notify/twilio-call.mjs` | twilio | call |

### Backfill

```bash
node scripts/backfill-cost-events.mjs
```

Idempotent via `dedup_key = backfill:msg:{messageId}`.

### Reconciliation

- Nightly worker job `cost-reconcile` → `POST /api/assistant/internal/cost-reconcile`
- **Anthropic:** no usage API with standard API key — documented; console billing only
- **OpenAI:** optional if `OPENAI_ORG_ID` + admin-capable key set; else logs note only
- Drift >15% → Tier 1 notify

---

## Pricing Constants (verification status)

| Provider / Model | Rate | Verified | lastVerifiedAt | Source |
|------------------|------|----------|----------------|--------|
| Anthropic claude-sonnet-4-6 input | $3.00 / 1M tokens | ✅ | 2026-06-12 | Anthropic pricing docs |
| Anthropic output | $15.00 / 1M tokens | ✅ | 2026-06-12 | Anthropic pricing docs |
| Anthropic cache write (5m) | $3.75 / 1M | ✅ | 2026-06-12 | Anthropic pricing docs |
| Anthropic cache read | $0.30 / 1M | ✅ | 2026-06-12 | Anthropic pricing docs |
| OpenAI text-embedding-3-small | $0.02 / 1M tokens | ✅ | 2026-06-12 | OpenAI model page |
| OpenAI whisper-1 | $0.006 / minute | ✅ | 2026-06-12 | OpenAI model page |
| Gemini flash image | $0.039 / image | ⚠️ estimate | 2026-06-12 | Google AI pricing (verify tier) |
| Gemini pro image | $0.134 / image | ⚠️ estimate | 2026-06-12 | Google AI pricing (verify tier) |
| Google TTS Chirp3 HD | $16.00 / 1M chars | ⚠️ estimate | 2026-06-12 | Cloud TTS pricing |
| Twilio outbound voice | $0.014 / minute | ⚠️ estimate | 2026-06-12 | Twilio US rates |

---

## Part 2 — Subscription Tracker

- Table: `agent_subscriptions`
- UI: list on `/agent/costs`
- API: `/api/assistant/costs/subscriptions`
- Tools: `list_subscriptions`, `add_subscription` (confirm card → `add_subscription` approve handler)
- Scheduler: `subscription-renewal` daily 10:00 Dhaka — alert ≤3 days; auto-advance `nextRenewalAt` after pass

**No seed data** — owner adds via conversation or dashboard API.

---

## Part 3 — Budgets & Alerts

KV keys: `cost.budget.dailyUsd`, `cost.budget.monthlyUsd`  
Alert dedup keys: `cost.alert.daily80.{date}`, `cost.alert.daily100.{date}`, monthly equivalents.

Worker `budget-check` hourly: 80% → Tier 1, 100% → Tier 2 (once per period).

---

## Part 4 — Dashboard UI

**Route:** `/agent/costs` (owner-only, `AGENT_ENABLED` required)

- Cards: today / month / forecast (MTD daily avg × days in month + subscription amortization)
- Stacked bar: 30-day daily by provider (recharts)
- Pie: provider breakdown this month
- Top 10 conversations by cost
- Subscription renewal badges
- Budget inputs + save
- CSV export with UTF-8 BOM (`/api/assistant/costs/export`)

---

## Part 5 — Functional Verification

Manual test plan:

1. Send 3 chats → 3 `anthropic/chat` events; sum matches dashboard “today”
2. One voice/TTS action → `google_tts` or `openai/transcribe` event
3. One memory save → `openai/embedding` event
4. Add subscription renewing in 2 days → run `subscription-renewal` → Tier 1 alert
5. Download CSV → opens in Excel/Sheets with Bangla-safe UTF-8 BOM

---

## FINAL PROJECT NOTE — Go-Live Checklist

After 2–3 months parallel running with Hermes, owner decides decommission. Until then:

### 1. Enable agent in production

```bash
# Vercel → Environment Variables → Production
AGENT_ENABLED=true
```

Redeploy production after setting.

### 2. Production env vars (agent module)

| Variable | Where | Purpose |
|----------|-------|---------|
| `AGENT_ENABLED` | Vercel | Kill switch |
| `ANTHROPIC_API_KEY` | Vercel | Chat |
| `OPENAI_API_KEY` | Vercel | Whisper + embeddings |
| `GEMINI_API_KEY` | Vercel + VPS worker | Image gen |
| `GOOGLE_TTS_CREDENTIALS` | Vercel + VPS | Bangla voice |
| `AGENT_INTERNAL_TOKEN` | Vercel + VPS (same value) | Worker ↔ app auth |
| `APP_URL` | VPS worker | Callback base URL |
| `REDIS_URL` | VPS | BullMQ |
| `SCHEDULERS_ENABLED` | VPS | `true` when ready |
| `ASSISTANT_BOT_TOKEN` | VPS | Telegram assistant bot |
| `TELEGRAM_OWNER_CHAT_ID` | VPS | Owner alerts |
| `NTFY_*` / `TWILIO_*` | VPS + Vercel | Alerts |
| `SENTRY_DSN` | Vercel + VPS | Monitoring |
| `DATABASE_URL` | Vercel + VPS | Postgres |
| `SUPABASE_*` | Vercel + VPS | Storage |
| `FB_PAGE_TOKEN_*` | Vercel | Facebook posts |
| `CRON_SECRET` | Vercel | Watchdog cron |

### 3. VPS worker

```bash
cd /opt/alma-erp/worker && pm2 restart agent-worker
```

### 4. Database

```bash
npx prisma migrate deploy
node scripts/backfill-cost-events.mjs   # one-time historical chat costs
```

### 5. Hermes decommission (owner decision only — NOT automated)

When owner confirms Hermes no longer needed:

1. Stop `pm2 stop hermes` on VPS
2. Archive DB already at `/opt/agent-backups/hermes-final/hermes.db`
3. Remove Hermes env vars from VPS after 30-day observation
4. Do **not** remove `/api/agent/*` routes until owner explicitly approves (ERP transition dependency)

### 6. Ongoing ops

- Cost dashboard: `/agent/costs`
- Runbook: `docs/PHASE-7-REPORT.md` (watchdog, backups, alerts)
- Backups: nightly `/opt/agent-backups/`

---

**Phase 8 completes the agent module (Phases 0–8). Merged to `main` per owner request.**
