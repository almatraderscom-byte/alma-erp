# Alma ERP - Actual Architecture

## What This Project Is

Multi-business ERP system supporting:

- Alma Trading (P2P/merchant operations)
- Creative Digital IT (agency client management)
- HR/Payroll/Attendance (employee management)
- Lifestyle Trading (legacy orders/CRM)
- Approvals workflow (cross-module)

## Tech Stack

- Next.js 14 (App Router)
- TypeScript strict
- Tailwind CSS
- Prisma + Supabase PostgreSQL (primary database)
- Google Apps Script + Sheets (legacy data store, being migrated)
- NextAuth (authentication)
- Sentry (error tracking)
- OneSignal (push notifications)
- Telegram Bot API (trading ops)

## Data Storage Reality (IMPORTANT)

**Postgres (Prisma) owns:**

- Authentication, Users
- Attendance, Selfies, Waivers
- Approvals
- Trading accounts, trades, Telegram queue
- Payroll wallet requests
- Notifications, SMS

**Google Sheets (GAS) owns:**

- Lifestyle Orders, Products, Stock
- HR Employee roster (with Postgres user link)
- Payroll timeline
- Invoices (with InvoiceRecord mirror in Postgres)
- Customers/CRM
- Creative Digital IT data

## Migration Status

Sheets → Postgres migration is gradual.

Phase 1 completed: Salary advance dual-write.

Future phases will migrate remaining Sheets data.

See `docs/MIGRATION.md` for details.

## Key Folders

- `/src/app` — Next.js pages and API routes
- `/src/components` — React components
- `/src/lib` — Utility functions, GAS bridge
- `/prisma` — Database schema
- `/gas` — Google Apps Script source
- `*.gs.js` (root) — Apps Script files (legacy, deployed via clasp)

## Operational Documentation

- `docs/MIGRATION.md` — Sheets → Postgres migration
- `docs/SENTRY.md` — Observability
- `docs/PRODUCTION_RUNBOOK.md` — Production operations
- `docs/archive/ecommerce-original-plan/` — Archived ecommerce planning docs (reference only)
