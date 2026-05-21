# Telegram Quick Entry — Internal Activation Checklist

**Status:** DB schema synced (2026-05-19). ERP operational rows still required.

## 1. Database (done)

```bash
# If pool is busy, use:
export DATABASE_URL="${DATABASE_URL%%\?*}?connection_limit=1&pool_timeout=30"
npx prisma db push
node scripts/verify-telegram-schema.mjs
```

## 2. ERP setup (admin — Trading → Telegram)

| Step | Action |
|------|--------|
| Groups | Add your real Telegram **group chat ID** (negative number). Bot shows unregistered chat ID on first message if unknown. |
| Users | For each staff member: Telegram user ID + link to ERP user + **Approved** |
| Aliases | e.g. `sh` → **MD Shahadat Hossain Traders** (or your accounts) |
| Webhook | Tab → Register webhook (production: https://alma-erp-six.vercel.app) |

## 3. Staff Telegram flow

1. `/setaccount sh` (or your alias)
2. `b 500 121.5 12` / `s 300 122 5`
3. `/summary` · `/undo` · `/account`
4. ERP admin confirms drafts → ledger

## 4. Verify scripts

```bash
node scripts/verify-telegram-schema.mjs
node scripts/verify-telegram-setup.mjs
node scripts/verify-telegram-activation.mjs
```
