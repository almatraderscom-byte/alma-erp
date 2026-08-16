# The demo instance

A throwaway copy of the ERP, filled with invented data, that can be handed to a
customer or an app reviewer. Nothing in it touches the real business.

## Why it is a separate deployment and not a "demo user"

`prisma/seed.cjs` already creates accounts ending in `@alma-erp.demo`, and
`src/lib/auth.ts` blocks them in production unless `ENABLE_DEMO_USERS=true`. Those
accounts are **logins only** — they read whichever database they are pointed at. Giving
one to a customer on production would expose real orders, real customer phone numbers
and real salaries, and let them edit or delete any of it.

So the demo is a second deployment against a second database. The isolation is the
database, not the login.

## What runs where

| Piece | Value |
|---|---|
| Supabase project | `alma-erp-demo`, ref `mcirhiamwfrxfdiqcsvh`, Mumbai `ap-south-1` |
| Supabase org | "Maruf Chowdhury's projects" — **Free plan, $0** (the Pro org holds production) |
| Vercel project | `alma-erp-demo`, team `maruf-s-projects2` |
| Connection | Session pooler `aws-0-ap-south-1.pooler.supabase.com:5432` |
| Local credentials | `.env.demo` (gitignored, never leaves the Mac) |

Session pooler, not the direct connection: direct is IPv6-only unless the paid IPv4
add-on is enabled.

## Environment variables

| Key | Value | Secret |
|---|---|---|
| `DATABASE_URL` | demo session-pooler URI | yes |
| `NEXTAUTH_SECRET` | random 32 bytes | yes |
| `API_SECRET` | random; shared between the app and its own GAS stub | yes |
| `DEMO_MODE` | `true` — the flag every guard keys off | no |
| `ENABLE_DEMO_USERS` | `true` — without it `auth.ts` refuses every `@alma-erp.demo` login | no |
| `AGENT_ENABLED` | `false` for now — see "Open question" | no |
| `NEXTAUTH_URL` | `https://alma-erp-demo.vercel.app` | no |
| `NEXT_PUBLIC_API_URL` | `https://alma-erp-demo.vercel.app/api/demo-gas` | no |

## The three things that make it safe

1. **A separate database.** Seeded by `scripts/demo-seed.mjs`, which refuses to run
   unless `ALMA_DEMO_SEED_CONFIRM=ALMA_DEMO_YES` is set and the target contains no
   non-demo user and no non-demo order. Every row it writes carries a `DEMO-` id prefix
   and the reset deletes only that prefix.

2. **`/api/demo-gas`.** Employees, Payroll, Finance, CDIT and Branding still read from
   the live Google Sheet via `server-api.ts`. Pointing `NEXT_PUBLIC_API_URL` at this stub
   is what stops a demo visitor seeing real staff names and real salaries. It answers
   from the seeded demo database, so Employees agrees with attendance and Finance agrees
   with the expense ledger. It 404s unless `DEMO_MODE=true` and the caller presents the
   deployment's own `API_SECRET`.

3. **Outbound channels suppressed.** `src/lib/demo-mode.ts` is checked by
   `sendSmsViaProvider`, `sendEmail`, `sendTelegramText` and `sendTelegramPhoto`. Without
   this a demo visitor creating an order would fire a real SMS, a real email and a real
   Telegram message from the company's accounts, to invented numbers, at the owner's cost.
   Each now reports success and dispatches nothing.

## Rebuilding it from scratch

The migration chain **cannot** build an empty database: its first migration
(`20260518154100_add_alma_trading`) adds a foreign key to `"User"`, and no migration in
the repo ever creates that table — production's schema predates the migration system.
Use `db push`:

```bash
set -a && . ./.env.demo && set +a
node scripts/demo-bootstrap.mjs                       # pgvector + pg_trgm
npx prisma db push --skip-generate --accept-data-loss # 233 models
ALMA_DEMO_SEED_CONFIRM=ALMA_DEMO_YES node scripts/demo-seed.mjs
```

## Nightly reset

`.github/workflows/demo-reset.yml` runs the same three steps at 20:00 UTC (02:00 Dhaka)
against the `DEMO_DATABASE_URL` repo secret, and skips quietly while that secret is
unset. Whatever a visitor types or deletes disappears overnight; the seed is
deterministic, so the same dataset comes back with dates relative to the run day.

The Supabase free plan pauses a project after ~7 days of inactivity — the nightly run is
also what keeps the demo awake.

## Logins

Ten accounts, all `@alma-erp.demo`, password `AlmaDemo2026!` (override with
`DEMO_USER_PASSWORD` at seed time): `owner` (Super Admin), `admin`, `ops`, `hr`,
`sales1`, `sales2`, `packing`, `support`, `delivery`, `viewer`.

## What the data looks like

10 staff · 45 products · 157 stock rows · 90 customers · 320 orders over 120 days
(187 delivered, ৳604,416 revenue, ৳279,177 profit) · 200 expenses · ~210 attendance
records. Customer segment, CLV and return rate are derived from the generated orders, so
the CRM agrees with the order list.

## Open question

`AGENT_ENABLED` is `false`. Running the real assistant on fake data is the most
convincing part of the demo, but every message costs money and a visitor can send as
many as they like. Turning it on should come with a hard per-day cap, not just a cheaper
model.
