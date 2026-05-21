# Alma Trading — Telegram Quick-Entry Bot (Operational Plan)

**Model:** User-isolated · **No shift/session layer**

Last updated: 2026-05-19 (production polish pass)

---

## Architecture summary

```
Telegram group (multi-staff, multi-account)
  → Webhook POST /api/telegram/webhook
  → trading-telegram-service (auth: approved chat + user)
  → trading-telegram-parser (commands + trade lines)
  → trading-telegram-user-ops (per-user numbering, duplicates, summary, undo)
  → TradingTelegramDraft (PENDING) in Postgres
  → ERP Trading → Telegram (grouped review)
  → Confirm → TradingTrade (ledger; balances/P/L update)
```

**Isolation key:** `telegramUserId` — every operational artifact (default account, drafts, trade numbers, fingerprints, summary, undo) is scoped to the individual Telegram user, not the group or a shared shift.

**Ledger safety:** Telegram never posts trades directly unless `TELEGRAM_AUTO_POST_TRADES=true` (default: draft-only).

---

## Removed shift logic (summary)

The following were **never shipped** and remain **out of scope**:

| Removed | Reason |
|--------|--------|
| `/startshift`, `/endshift` | Shared shift model conflicts with multiple staff in one group |
| Shift tracking tables/fields | Unnecessary complexity |
| Shared session / shift-based grouping | Operators work in parallel on different accounts |
| Shift-scoped summaries | `/summary` is per requesting user only |

No shift-related code exists in `src/lib/trading-telegram-*` or ERP Telegram admin.

---

## User-isolated workflow

1. **Admin** maps Telegram user → ERP user, approves group chat, defines aliases (`sh` → account).
2. **Operator** runs `/setaccount sh` once (stored on their `TradingTelegramUser` row).
3. **Quick capture:** `b 500 121.5 12` or `sh b 500 121.5 12`.
4. **System assigns** (per user, per BD calendar day):
   - Auto trade number (`tradeNumber`)
   - Draft fingerprint (account + side + amounts + fee)
   - Duplicate check (same fingerprint within 30 min → blocked)
5. **Operator tools:** `/summary` (own stats), `/undo` (last own PENDING draft → `UNDONE`).
6. **ERP reviewer** confirms drafts → ledger; balances unchanged until then.

---

## Telegram commands

| Command | Scope | Description |
|---------|-------|-------------|
| `b 500 121.5 12` | User | Buy draft (uses default account) |
| `s 300 122 5` | User | Sell draft |
| `sh b 500 121.5 12` | User | Buy with account prefix |
| `/setaccount sh` | User | Set default account alias |
| `/summary` | User | Today's trades, volumes, pending count, est. P/L |
| `/undo` | User | Undo last PENDING draft (status → `UNDONE`) |
| `/help` | — | Command reference |
| `/account` | User | Show current default account |
| `BUY` / `SELL` keyboard | User | Hint for trade format |
| Hide keyboard | User | Collapse reply keyboard |

**Not supported:** `/startshift`, `/endshift`, group-wide summary, shared undo.

**Flexible input:** `b500 121.5 12`, `buy 500 …`, `sh buy 500 …` (normalized before parse; raw message preserved).

**Duplicates:** Warning + inline **Save anyway** / **Cancel** (not hard-blocked).

**Auto-lock:** Prior-day `PENDING` → `LOCKED` after `TELEGRAM_DRAFT_LOCK_HOUR_BD` (default 6). Admin **Reopen** in ERP.

---

## ERP integration

**Route:** Trading → Telegram (`/trading/telegram`)

**Draft queue API:** `GET /api/trading/telegram/drafts?status=PENDING&grouped=1`

**Grouping:** ERP user + Telegram username/id + trading account (via `groupDraftsByUserAndAccount`).

**Draft fields:** `tradeNumber`, `draftFingerprint`, `status` (includes `UNDONE`), `undoneAt`.

**Review actions:** Confirm (post to ledger), Edit, Reject, Bulk confirm.

---

## Production readiness

| Item | Status |
|------|--------|
| User-isolated parser + service | Done |
| Auto trade numbering | Done |
| `/summary`, `/undo`, duplicate detection | Done |
| ERP grouped draft UI | Done |
| Prisma schema (`UNDONE`, `tradeNumber`, etc.) | In repo — run `npx prisma db push` on prod DB |
| Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` | Required in Vercel |
| Webhook registration | `POST /api/trading/telegram/setup` from admin UI |
| Token in chat history | **Rotate via BotFather** if exposed |

**Smoke test checklist**

1. Unapproved user → rejected in group.
2. `/setaccount` → subsequent `b …` uses that account.
3. Two users in same group → independent trade numbers and summaries.
4. Duplicate same line within 30 min → warning, no second draft.
5. `/undo` → only caller's last pending draft.
6. ERP confirm → trade appears on account ledger; balance updates.

---

## Performance & simplicity goals

- Minimal commands; no session management overhead.
- O(1) duplicate lookup via indexed `draftFingerprint` + `telegramUserId`.
- Daily trade numbers reset per BD day per user.
- Group chat scales to N operators × M accounts without coordination.
