# Phase 4/5 Migration Close-out Notes

**Branch:** `feat/migration-final-cleanup`  
**Date:** 2026-06-15 (Asia/Dhaka)  
**Base:** `main` @ `77e00fd` (after night-report worker fix)

## Summary

GAS→Supabase lifestyle migration is **complete for operational reads/writes**. Postgres is source of truth; GAS receives a nightly snapshot only (`postgres_snapshot_sync`). This close-out removed the last lifestyle-critical GAS fallbacks and documented justified KEEP cases.

---

## Step 2 — `serverGet` / `serverPost` classification

### KEEP (out of scope — HR / finance / CDIT / trading / branding)

| File | Route / purpose |
|------|-----------------|
| `src/app/api/hr/*` | `hr_employees`, `hr_payroll`, `hr_dashboard`, etc. |
| `src/app/api/finance/*` | `finance`, `financial_report`, `add_expense` |
| `src/app/api/digital/*` | `cdit_*` |
| `src/lib/trading-drive.ts` | Trading screenshot Drive ops |
| `src/lib/payroll-*.ts` | Payroll sheet mirror |
| `src/lib/lifestyle/dashboard.ts` | `finance` + `hr_dashboard` slices only (orders from Postgres) |
| `src/lib/agent-api/services/reports.service.ts` | `finance` enrichment |
| `src/lib/agent-api/services/employees.service.ts` | HR |
| `src/app/api/branding/route.ts` | Brand assets (cross-business) |
| `src/app/api/invoice/route.ts` | `save_invoice_pdf` (Drive upload), `branding` peek |
| `src/app/api/health/route.ts` | `api_health` connectivity probe |
| `src/app/api/audit/route.ts` | `audit_log` |
| `src/app/api/log/route.ts` | General GAS log |

### KEEP (backup export)

| File | Purpose |
|------|---------|
| `src/lib/lifestyle/gas-export.ts` | Nightly `postgres_snapshot_sync` Postgres→Sheet |

### KEEP (GAS-only, no Postgres equivalent yet — documented follow-up)

| File | Call | Why kept |
|------|------|----------|
| `src/lib/agent-api/services/inventory.service.ts` | `serverGet('log', { type: 'inventory' })` | Stock **movement audit log** lives only in GAS `LOG` sheet. Postgres tracks current stock levels, not per-adjustment history. **Follow-up:** optional `lifestyle_stock_movements` table (separate small task). Read-only, low risk. |

### MIGRATED in this close-out (were lifestyle GAS)

| Before | After |
|--------|-------|
| `website-order-ingest.ts` → `create_order` GAS POST | `dispatchCreateOrder` → Postgres |
| `invoice/public/[slug]` → `serverGet('order')` | `getLifestyleOrder` from Postgres |
| `invoice/route.ts` → `next_invoice_num` GAS GET | `peekNextInvoiceNumber` / `reserveNextInvoiceNumber` via `LifestyleInvoiceSequence` |
| `customers/backfill` → `admin_backfill_crm` GAS POST | `backfillCustomersFromOrdersInPostgres` |
| `supplier-import/commit` → `batch_import_product_master` GAS | `dispatchCreateProduct` loop (Postgres) |

---

## Step 4 — Nightly GAS backup verification

| Check | Result |
|-------|--------|
| Cron registered | ✅ `vercel.json` → `0 3 * * *` (03:00 UTC daily) |
| Auth | ✅ `GET /api/cron/lifestyle-gas-export` requires `Authorization: Bearer ${CRON_SECRET}` |
| Failure alerting | ✅ Already present: `notifyOwner` tier-2 urgent on `!result.ok` or thrown error |
| Manual export smoke | ✅ `npx tsx scripts/migration/smoke-phase4-5.ts` — gas snapshot **OK** in **24.2s** |

Export stats (2026-06-14 run):

```
orders_upserted: 310, stock_upserted: 541, products_upserted: 18, customers_upserted: 262, errors: 0
```

---

## Step 5 — Data integrity counts

| Source | Orders | Stock | Products | Customers |
|--------|--------|-------|----------|-----------|
| **Postgres** (2026-06-14) | 310 | 541 | 18 | 262 |
| **GAS sheet** (after fresh export) | 310 | 541 | 18 | 262 |

Counts match after manual snapshot sync. Expected lag ≤24h between Postgres writes and sheet if cron-only (Option B).

`peekNextInvoiceNumber()` → `AL-INV-2026-0016` (aligned with Phase 1 import seed).

---

## Step 6 — Verification

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | ✅ PASS |
| `npm run build` | ✅ PASS |
| `smoke-phase4-5.ts` | ✅ ALL PASS |
| Lifestyle GAS grep | Only `gas-export` + inventory `log` (documented) |

---

## Honest caveats

- **Invoice PDF Drive upload** still uses GAS `save_invoice_pdf` — intentional (Drive integration not migrated).
- **Inventory movement history** still GAS `log` — needs new table if we want Postgres audit trail.
- **DB backup restore test** is Prompt 3 (separate from this GAS export verification).
