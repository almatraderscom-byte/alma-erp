# Alma Trading Telegram — Pre-Production Audit Report

**Phase:** Internal testing only  
**Date:** 2026-05-19  
**Architecture verified:** Telegram → Draft → ERP Review → Confirm → Ledger (unchanged)

---

## Executive summary

| Area | Status |
|------|--------|
| Codebase / build | **PASS** — type-check, build, parser smoke (8/8) |
| Ledger isolation | **PASS** — drafts only from Telegram; ledger via `postDraftToLedger` |
| Prisma schema | **PASS** — `prisma validate` + generate |
| Remote DB sync | **BLOCKED** — pool limit during `db push`; manual push required |
| Vercel Telegram env | **FAIL** — no `TELEGRAM_*` vars on project |
| Preview deploy | **FAIL** — missing Preview env (`NEXTAUTH_SECRET`, `DATABASE_URL`, …) |
| Live webhook (prod URL) | **WARN** — `GET/POST /api/telegram/webhook` returns 401 (stale deploy or protection) |

---

## Fixes applied this audit

1. **`src/app/api/trading/telegram/setup/route.ts`** — `appBaseUrl()` uses `VERCEL_URL` so preview deployments register webhooks to the correct host (not production alias).

---

## Manual steps required (ops)

1. Add to Vercel **Production + Preview**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `TELEGRAM_DRAFT_LOCK_HOUR_BD` (optional).
2. Run `npx prisma db push` when DB pool available (applies `LOCKED`, `TradingTelegramPendingDuplicate`, etc.).
3. Copy Production env vars to Preview OR use `vercel env pull` for preview deploys.
4. Redeploy production with latest code; re-register webhook from ERP → Webhook tab.
5. Do **not** rotate bot token until end of internal test phase (per request).

---

## Smoke test script

```bash
npx tsx -e "import { parseTelegramTradeMessage } from './src/lib/trading-telegram-parser.ts'; ..."
# Or: node scripts/telegram-smoke-test.mjs (via tsx)
```

Parser smoke: **8/8 passed** locally.

---

## Operational test checklist (manual)

See sections 4–9 in parent task; execute in Telegram group after env + db push + webhook register.
