# Alma ERP

Multi-business operations platform for Alma Trading, Creative Digital IT,
and HR/Payroll management.

## Stack

Next.js 14 · TypeScript · Tailwind · Prisma · Supabase · NextAuth · Sentry

## Quick Start

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Environment

Copy `.env.example` to `.env.local` and fill in:

- `DATABASE_URL` (Supabase Postgres — **pooler** `:6543` with `?pgbouncer=true&connection_limit=10` on Vercel; direct `:5432` for local `db push` only — see [docs/SUPABASE_POSTGRES_SETUP.md](./docs/SUPABASE_POSTGRES_SETUP.md))
- `NEXTAUTH_SECRET`
- `NEXT_PUBLIC_API_URL` (Google Apps Script Web App)
- `API_SECRET`

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System architecture
- [CODING_STANDARDS.md](./CODING_STANDARDS.md) — Code style
- [FOUNDATION.md](./FOUNDATION.md) — Original foundation docs
- [docs/MIGRATION.md](./docs/MIGRATION.md) — Sheets → Postgres migration progress
- [docs/SENTRY.md](./docs/SENTRY.md) — Error tracking setup

Archived ecommerce planning docs (reference only): [docs/archive/ecommerce-original-plan/](./docs/archive/ecommerce-original-plan/)

## Scripts

- `npm run dev` — Local development
- `npm run build` — Production build
- `npm run type-check` — TypeScript validation
- `npm run db:push` — Update Postgres schema
- `npm run gas:push` — Deploy Apps Script
