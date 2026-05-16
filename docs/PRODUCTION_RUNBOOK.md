# Alma ERP Production Runbook

## Deployment

1. Configure Vercel env vars from `.env.production.example`.
2. Use Supabase **session pooler** for runtime `DATABASE_URL`.
3. Run `npx prisma db push` only from a trusted admin machine/CI job.
4. Deploy to Vercel; `vercel.json` schedules `/api/cron/payroll-accrual` on the 10th of every month.

## Required Environment

- `DATABASE_URL`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_API_URL`
- `API_SECRET`
- `CRON_SECRET` (recommended; falls back to `NEXTAUTH_SECRET` if unset)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_EXPENSE_RECEIPTS_BUCKET` (optional, default `expense-receipts`)
- `SESSION_MAX_AGE_SECONDS` (optional, default 30 days)

## Supabase Storage / Expense Receipts

Expense receipts use a private Supabase Storage bucket and signed, authenticated app URLs.

Configure these in **Vercel → Project → Settings → Environment Variables → Production**:

- `SUPABASE_URL`: Supabase project URL, for example `https://PROJECT_REF.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service role key. Never add this as `NEXT_PUBLIC_*`.
- `SUPABASE_EXPENSE_RECEIPTS_BUCKET`: optional; defaults to `expense-receipts`.
- `NEXT_PUBLIC_SUPABASE_URL`: optional public project URL only if client-side Supabase is later needed.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: optional public anon key only if client-side Supabase is later needed.

After changing Vercel env vars, redeploy production and verify `/api/health` reports:

```json
{
  "storage": {
    "expense_receipts_configured": true,
    "expense_receipts_bucket": "expense-receipts",
    "private_signed_access": true
  }
}
```

The upload route validates auth, business access, file type, and a 10 MB size limit before writing to Storage.

## Supabase Pooling

- Runtime: use Supabase session pooler (`aws-...pooler.supabase.com:5432`).
- Migrations: use direct database URL if Supabase DNS allows it, otherwise session pooler is acceptable for `db push`.
- Avoid transaction pooler `:6543` for Prisma schema pushes.

## Backups / Recovery

- Enable Supabase Point-in-Time Recovery if available on the plan.
- Keep daily logical backups for payroll tables:
  - `User`
  - `EmployeeLedgerEntry`
  - `WalletRequest`
  - `PayrollAccrualRun`
  - `Notification`
- Before any schema push, export affected tables from Supabase Studio or `pg_dump`.
- Recovery drill: restore into a staging project, run `/api/health`, then compare payroll wallet totals.

## Monitoring

- `/api/health` reports env, database, wallet ledger, and GAS status.
- Settings → Database shows live health in the UI.
- Vercel logs include structured JSON via `logEvent`.
- Watch for:
  - accrual failures
  - wallet request approval errors
  - invoice PDF memory/timeouts
  - GAS route 500s

## Cron Operations

- Automatic payroll accrual: 10th day monthly.
- Manual rerun: Payroll → Run now.
- Duplicate prevention: one salary accrual per employee/business/month.
- Retry protection: `RUNNING` runs are blocked for one hour unless forced manually.

## Known Production Risks

- GAS endpoint availability still affects legacy dashboards and employee roster enrichment.
- PDF generation is browser/client-heavy; very large reports should be exported in smaller business/month scopes.
- In-memory rate limiting resets per serverless instance; use Upstash/Redis for stricter global limits later.
