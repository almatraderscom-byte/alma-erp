# Supabase PostgreSQL for Alma ERP (Auth & Users)

Alma ERP stores **accounts, roles, salary-advance workflow state**, and related auth tables in **PostgreSQL**. This guide uses **[Supabase](https://supabase.com)** as the hosted Postgres provider while keeping **Google Apps Script / Sheets** unchanged for operational ERP data.

## 1. Create the database

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Choose a region close to your users and set a strong **database password** (save it in a password manager).

## 2. Connection strings

Open **Project Settings → Database → Connection string**.

### Option A — Direct connection (simplest for Prisma CLI)

Use **URI** mode (PostgreSQL). It looks like:

`postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres`

- Replace `[YOUR-PASSWORD]` with the **database password** (URL-encode special characters, e.g. `@` → `%40`).
- `[PROJECT-REF]` is your project reference from the hostname.

Set this as **`DATABASE_URL`** in **both** `.env.local` (Next.js) and `.env` (Prisma CLI / `db push` / `db seed`).

### Option B — Transaction pooler (serverless / many short connections)

Supabase recommends the **pooler** for many serverless instances. Typical format (from the dashboard):

`postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true`

For **migrations / `db push`**, Supabase often suggests a **direct** connection. You can:

- Temporarily set `DATABASE_URL` to the **direct** URI for `npx prisma db push`, then switch to the pooler for production, or  
- Add a `directUrl` in `schema.prisma` and a `DIRECT_URL` env var (see [Prisma + PgBouncer](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer)).

The stock Alma schema uses **`url = env("DATABASE_URL")` only** — use a **direct** URL for local and first-time `db push` unless you add `directUrl`.

## 3. Configure env files (this repo)

| File        | Purpose                                      |
|------------|-----------------------------------------------|
| `.env.local` | Next.js runtime (includes `DATABASE_URL`)   |
| `.env`       | Prisma CLI (`db push`, `db seed`)          |

Keep **non-database** variables (e.g. `NEXT_PUBLIC_API_URL`, `API_SECRET`, `NEXTAUTH_*`) **only where you already use them** — do not remove them.

## 4. Apply schema and seed demo users

From the project root:

```bash
npx prisma generate
npx prisma db push
npm run db:seed
```

Demo seeding is for local development only. In production, demo users are blocked unless `ENABLE_DEMO_USERS=true` is explicitly configured.

## 5. Verify in the app

1. Open **Settings → Database** (`/settings/database`).
2. Confirm **PostgreSQL / Prisma** show connected after `DATABASE_URL` is correct.
3. Sign in at `/login` and confirm **session** persists and **protected routes** redirect when logged out.

## 6. Security notes

- Never commit `.env` or `.env.local` (both are gitignored here).
- Rotate the DB password if it was pasted into chat or CI logs.
- **RLS**: Alma uses Prisma with a single DB role; Row Level Security policies are optional and not configured by default — rely on **NextAuth JWT + API guards** for authorization.

## 7. Supabase Storage for expense receipts

Expense receipt uploads use Supabase Storage separately from Postgres.

Set these server-side values locally and in Vercel Production:

- `SUPABASE_URL`: Supabase project URL, for example `https://PROJECT_REF.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY`: service role key used only by Next.js API routes.
- `SUPABASE_EXPENSE_RECEIPTS_BUCKET`: optional; defaults to `expense-receipts`.

Optional public values may be set for future browser-side Supabase clients:

- `NEXT_PUBLIC_SUPABASE_URL`: project URL only.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: anon/public key only.

Never store the service role key in a `NEXT_PUBLIC_*` variable. Alma receipt APIs create or use a private bucket, store receipt metadata in Postgres, and return authenticated app URLs that generate short-lived signed Storage URLs.

## 8. Google Sheets / GAS

**No change required** for Apps Script: `NEXT_PUBLIC_API_URL` and `API_SECRET` continue to drive Google Sheets ERP behaviour. Postgres only backs **authentication and user RBAC** in Next.js.
