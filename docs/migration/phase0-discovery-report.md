# Phase 0 — GAS → Supabase Migration: Discovery Report

**Branch:** `feat/supabase-migration-phase0`  
**Base commit:** `6a4ebb4` (main, 2026-06-14)  
**Phase scope:** Discovery + schema design only. No production code changes. No data writes.  
**Live API:** GET requests only against production GAS deployment.

---

## 1. Sheet inventory

### How this was gathered

The repo’s stale `gas/WebApp_API.gs` includes a `debug` route (`getDebugInfo_`) that would return spreadsheet ID, tab list, row counts, and column headers. **That route is not deployed on live GAS** (returns `Unknown GET route: "debug"`). Tab inventory below is therefore inferred from:

- `WebApp_API.gs.js` `SHEETS` constants and handler code
- Live GET volume checks (2026-06-14)
- Column maps in GAS (`OC`, stock 20-col layout, customer 29-col layout, ORDER_ITEMS 19-col layout)

### Spreadsheet (inferred)

| Property | Value |
|----------|-------|
| Binding | Container-bound to Alma Lifestyle workbook (script is not standalone) |
| Script ID (live) | `1cloQRy47d8buv9C92BZGO_iPswmvWeBfroJK_6kjZfPDkyGLj6eUo5NN` |
| Deploy URL | `config/gas-production-deployment.txt` / `.env.production.example` |
| Release stamp | `2026-05-29T19:58Z` |

> **Open item:** Maruf should export the live spreadsheet ID + full tab list from Google Sheets (File → Spreadsheet settings) or re-deploy a `debug` route — see Section 6.

### Relevant tabs (Lifestyle ERP scope)

| Sheet tab (GAS name) | Data start row | Live row count (approx.) | Purpose |
|----------------------|----------------|--------------------------|---------|
| `📦 ORDERS` | Row 3 | **310 orders** (`AL-0001` … `AL-0310`) | Core order ledger (45 cols A–AS) |
| `🧾 ORDER ITEMS` | Row 2 headers | Unknown (not exposed via GET) | Multi-line order line items (19 cols) |
| `📦 STOCK CONTROL` | Row 3 | **541 rows** (326 active SKUs in summary; 215 archived) | Per-SKU+size inventory |
| `PRODUCT MASTER` (aliases) | Row 3 | **18 products** | Catalog defaults (price/COGS/active) |
| `👥 CUSTOMERS` | Row 6 | **281 customers** | CRM profiles (29 cols) |
| `💸 EXPENSE LEDGER` | Row 2 | Not counted (finance route) | Expenses — **out of Phase 1 Lifestyle core** unless owner expands |
| `🤖 AUTOMATION LOG` | — | — | Automation events (optional import) |
| `📜 ERP AUDIT LOG` | — | — | Mutation audit (GAS-side) |

**Promos:** No sheet tab found in GAS source. Agent `promos` route is **not implemented** on live API.

### Column headers (from GAS source)

#### 📦 ORDERS (45 columns, `OC` map in `WebApp_API.gs.js`)

| Col | Field |
|-----|-------|
| A | ORDER_ID |
| B | DATE |
| C | CUSTOMER |
| D | PHONE |
| E | ADDRESS |
| F | PAYMENT |
| G | SOURCE |
| H | STATUS |
| I | PRODUCT |
| J | CATEGORY |
| K | SIZE |
| L | QTY |
| M | UNIT_PRICE |
| N | DISCOUNT |
| O | ADD_DISCOUNT |
| P | ADV_COST |
| Q | ADV_PLATFORM |
| R | SELL_PRICE (formula) |
| S | SHIP_COLLECTED |
| T | COGS |
| U | COURIER_CHARGE |
| V | OTHER_COSTS |
| W | PROFIT (formula) |
| X | COURIER |
| Y | TRACKING_ID |
| Z | TRACKING_STATUS |
| AA | EST_DELIVERY |
| AB | ACTUAL_DELIVERY |
| AC | RETURN_REASON |
| AD | RETURN_DATE |
| AE | RETURN_STATUS |
| AF | NOTES (includes `ORDER_ITEMS_JSON:` blob) |
| AG | SKU (VLOOKUP formula) |
| AH | HANDLED_BY |
| AI | CUST_ORDER_NUM (formula) |
| AJ–AP | Automation cols (Phase 2 triggers) |
| AQ (44) | INVOICE_NUM |
| AS (45) | BUSINESS_ID |

Cols 39–41 (sheet): `days_pending`, `days_in_transit`, `sla_status` — written by automation, read by `rowToOrder_`.

#### 📦 STOCK CONTROL (20 columns)

SKU, Product, Category, Color, Size, Opening, Purchased, Sold, Returned, Damaged, Reserved, Current Stock, Available, Reorder Level, Status, Stock Value, Sell Value, Potential Profit, (unused), Meta JSON (col 20).

#### PRODUCT MASTER (flexible headers; resolved by alias)

SKU, Product name, Category, Default COGS, Default price, Active, Notes (+ optional image, supplier, variants on create).

#### 👥 CUSTOMERS (29 columns, row 6+)

ID, Name, Phone, District, Address, WhatsApp, Total orders, Delivered, Returned, Cancelled, Pending, Total spent, Avg order, Total profit, COD orders, COD fails, COD fail %, Return rate, Last order, Days inactive, Fav category, CLV score, Risk score, Risk level, Segment, Loyalty pts, Source, WA opt-in, Notes.

#### 🧾 ORDER ITEMS (19 columns)

ORDER_ID, LINE_NO, SKU, PRODUCT_CODE, PRODUCT, CATEGORY, SIZE, VARIANT, QTY, UNIT_PRICE, SELL_PRICE, SUBTOTAL, COGS, STOCK_SKU, COLLECTION_CODE, COLLECTION_TYPE, SIZE_GROUP, VARIANT_GROUP, CREATED_AT.

---

## 2. GAS source completeness

### Repo state (Step 1)

| File | Lines | `function` count | Status |
|------|-------|------------------|--------|
| `gas/WebApp_API.gs` | 832 | 27 | **STALE** — missing products, promos, invoice, inventory mutations |
| `WebApp_API.gs.js` (repo root) | 3755 | 147 | **PRIMARY** — deployed via `npm run gas:deploy` / `.clasp.json` |
| `Phase4_Invoice.gs.js` | ~1100 | — | Invoice PDF generation (Drive) |
| `Phase5_CRM.gs.js` | ~698 | — | Customer profile automation |
| `Gas_Release.gs.js` | — | — | Release stamp |

**Deploy path:** `scripts/gas-deploy.sh` → clasp push + `clasp deploy` to fixed deployment ID in `config/gas-production-deployment.txt`.

### Routes: repo vs live vs Next.js callers

| Route | In `gas/WebApp_API.gs` | In `WebApp_API.gs.js` | Live GET/POST works | Called from Next.js |
|-------|------------------------|----------------------|---------------------|---------------------|
| `orders`, `order` | ✅ | ✅ | ✅ GET | ✅ |
| `create_order`, `update_status`, `update_tracking`, `update_field` | ✅ | ✅ | ✅ POST | ✅ |
| `stock` / `inventory` | ✅ (simplified) | ✅ (full) | ✅ GET | ✅ |
| `products` | ❌ | ✅ | ✅ GET (18) | ✅ |
| `create_product`, `batch_import_product_master` | ❌ | ✅ | ✅ POST | ✅ |
| `update_product` | ❌ | ❌ | ❌ **not in dispatcher** | ✅ agent only |
| `customers` | ✅ partial | ✅ | ✅ GET (281) | ✅ |
| `create_customer` | ❌ | ✅ (Phase5) | ✅ POST | ✅ |
| `update_customer` | ❌ | ❌ | ❌ | ✅ agent only |
| `promos`, `create_promo`, `update_promo`, `deactivate_promo`, `delete_promo` | ❌ | ❌ | ❌ unknown route | ✅ agent (graceful empty) |
| `dashboard`, `analytics` | ✅ partial | ✅ | ✅ GET | ✅ |
| `next_invoice_num` | ❌ | ✅ | ✅ GET → `AL-INV-2026-0016` | ✅ |
| `save_invoice_pdf` | ❌ | ✅ | ✅ POST | ✅ |
| `debug` | ✅ | ❌ | ❌ | — |
| `finance`, `log` | ✅ | ✅ | ✅ | finance routes |

### Still missing / needs owner action

1. **`debug` route** — useful for Phase 1 import sizing; not in deployed `WebApp_API.gs.js`.
2. **`update_product` / `update_customer`** — TypeScript agent services call these, but GAS `dispatchRoutePost_` has no handlers (mutations likely fail silently or error).
3. **Promos** — entire feature is TS-only stubs; no sheet, no GAS. Confirm whether promos are planned or dead code.
4. **Spreadsheet ID** — not in repo (correctly); confirm workbook identity for import script.

---

## 3. Route → data shape mapping

### Orders (`orders`, `order`, `create_order`, `update_status`, `update_field`, `update_tracking`)

**GAS baseline:** `rowToOrder_()` in `WebApp_API.gs.js` (~line 3345).  
**TS type:** `src/types/index.ts` `Order` interface — **matches live JSON field set** (verified 2026-06-14).

**Read fields (API response per order):**

`id`, `date`, `customer`, `phone`, `address`, `payment`, `source`, `status`, `product`, `category`, `size`, `qty`, `unit_price`, `discount`, `add_discount`, `adv_cost`, `adv_platform`, `sell_price`, `shipping_fee`, `cogs`, `courier_charge`, `other_costs`, `profit`, `courier`, `tracking_id`, `tracking_status`, `est_delivery`, `actual_delivery`, `return_reason`, `return_date`, `return_status`, `notes`, `sku`, `handled_by`, `sla_status`, `days_pending`, `days_in_transit`, `auto_flag`, `invoice_num`, `business_id`, `paid_amount`, `due_amount`, `estimatedProfit`, `realizedProfit`, `reversedProfit`, `net_profit`, `return_net_profit`, `shipping_margin`, `merchandise_profit`, `returnType`, `courierCost`, `inventoryCost`, `stockRestored`, `stockRestoredAt`, `stockRestoreReason`, `items[]`, `margin_pct`.

**Write fields (`create_order`):** Core cols C–V, AF (notes), AH; formulas for ORDER_ID, SELL_PRICE, PROFIT; `items[]` → `🧾 ORDER ITEMS` + `ORDER_ITEMS_JSON:` in NOTES.

**Computed on read (do not store as static truth):**

| Field | Source |
|-------|--------|
| `margin_pct` | `round(net_profit / sell_price * 100)` |
| `days_pending`, `days_in_transit`, `sla_status` | Sheet automation cols / date math vs “now” |
| `estimatedProfit`, `realizedProfit`, `reversedProfit`, etc. | `calculateOrderAccounting_()` + NOTES meta |
| `items[]` | Parsed from `ORDER_ITEMS_JSON:` in NOTES |

**Call sites:**

| File | Routes used |
|------|-------------|
| `src/app/api/orders/orders/route.ts` | `orders`, `order`, `create_order` |
| `src/app/api/orders/orders/edit/route.ts` | `update_field` |
| `src/app/api/orders/orders/status/route.ts` | `update_status` |
| `src/app/api/orders/orders/tracking/route.ts` | `update_tracking` |
| `src/app/api/orders/orders/delete-request/route.ts` | (workflow — may use `update_field`) |
| `src/lib/agent-api/orders.service.ts` | orders mutations |
| `src/agent/lib/catalog/inventory-lookup.ts` | `orders` (read) |
| `src/agent/lib/staff-task-proposal.ts` | orders read |
| `src/lib/inventory-with-sales.ts` | orders aggregate |
| `src/lib/outcome-metrics.ts` | orders metrics |
| `src/lib/business-archive/modules.ts` | archive read |
| `src/app/api/invoice/route.ts` | order fetch for PDF |
| `src/app/api/invoice/public/[slug]/route.ts` | public invoice |

**Order ID format (live):** `AL-0001` … `AL-0310` (zero-padded 4-digit). Invoice numbers use separate prefix `AL-INV-2026-NNNN`.

---

### Stock / Inventory (`stock`)

**GAS:** `getInventory_()` — 20 sheet columns + JSON meta col 20.  
**Stale `gas/WebApp_API.gs` `getStock_()`** returns simplified 9 fields with `stock_value/sell_value/potential_profit` hardcoded to 0 — **live deployment uses full `getInventory_()`** (values populated; live `total_value` ≈ ৳41,989,665).

**Grain:** **One row per SKU + size** (541 rows; each `sku` unique in practice).

**Fields:** `sku`, `product`, `category`, `color`, `size`, `opening`, `purchased`, `sold`, `returned`, `damaged`, `reserved`, `current_stock`, `available`, `reorder_level`, `status`, `stock_value`, `sell_value`, `potential_profit`, plus inferred/stored meta: `collectionCode`, `collectionType`, `sizeGroup`, `variantGroup`, `buyingPrice`, `barcode`, `archived`, `imageUrl`, `active`.

**POST routes (inventory mutations):** `inventory_edit`, `inventory_adjust`, `inventory_archive`, `inventory_restore`, `inventory_bulk_update` — used by `src/app/api/stock/route.ts`.

**Call sites:** `src/app/api/stock/route.ts`, `src/agent/lib/catalog/inventory-lookup.ts`, `src/lib/pricing-insight.ts`, `src/lib/agent-api/services/inventory.service.ts`, `src/lib/agent-api/services/products.service.ts`, `src/lib/website/consistency.ts`.

---

### Products (`products`, `create_product`)

**GAS:** `getProducts_()` / `createProduct_()` / `batchImportProductMaster_()`.

**Read shape:** `{ id, sku, name, category, default_price, default_cogs, active, notes, updated_at }`  
**Live sample:** `PUN-001`, Classic White Punjabi, category Punjabi, price 1499.

**Create writes:** sku, name, category, cogs, price, active, notes, image_url, supplier, variants_json; optional `sync_to_stock` creates stock row.

**`update_product`:** Called from agent (`src/lib/agent-api/services/products.service.ts`) but **no GAS handler** — needs Postgres implementation in Phase 2+.

**Website note:** `src/lib/website/types.ts` `WebsiteProductRow` is a **separate Supabase project** (almatraders.com, ~95 products). SKU namespace may overlap conceptually but schemas must not be merged.

---

### Customers (`customers`, `create_customer`)

**GAS:** `getCustomers_()` (29 cols); `create_customer` → `triggerCreateCustomer_()` → Phase5 `ensureCustomerProfile_()`.

**Read shape:** matches `src/types/index.ts` `Customer` (verified live `CUST-0001`).

**`update_customer`:** Agent-only; **no GAS handler**.

**Call sites:** `src/app/api/customers/route.ts`, `src/lib/agent-api/services/customers.service.ts`.

---

### Promos (`promos`, `update_promo`, `deactivate_promo`, `delete_promo`)

**Status:** **NOT DEPLOYED.** Live API: `Unknown GET route: "promos"`.  
**TS expects:** `{ promos: [{ id, code, discount_pct, discount_amount, active, expires_at, usage_count }] }`  
**TS behavior:** `listPromos()` catches errors → empty array.

**Recommendation:** Defer `LifestylePromo` table until owner confirms promos are a real business feature.

---

### Dashboard / Analytics (`dashboard`, `analytics`)

**GAS:** `getDashboard_()` / `getAnalytics_()` — **pure aggregation over ORDERS sheet** (+ expenses for some KPIs). No dedicated sheet.

**Recommendation:** **No new Postgres tables** for dashboard/analytics. Phase 2+ replaces GAS with SQL views/queries over `lifestyle_orders` (and existing ERP expense tables). Flag as major simplification win.

**Call sites:** `src/app/api/dashboard/route.ts`, `src/app/api/analytics/route.ts`, `src/lib/agent-api/services/reports.service.ts`.

---

### Invoices (`next_invoice_num`, `save_invoice_pdf`)

**GAS `next_invoice_num`:** Reads `ScriptProperties` key `AL_INV_COUNTER_{year}`, returns peek e.g. `{ next: "AL-INV-2026-0016" }` (does not increment on GET).

**GAS `save_invoice_pdf`:** Triggers Phase4 Drive PDF pipeline.

**Prisma already has:**

- `InvoiceRecord` — `invoiceNumber`, `orderId`, `amount`, `driveUrl`, `paymentStatus`, etc.
- `InvoiceEvent` — audit trail

**`src/app/api/invoice/route.ts` uses BOTH:**

1. GAS for `next_invoice_num` peek and legacy `save_invoice_pdf` (Drive)
2. Prisma `InvoiceRecord` for listing, payment status, archive
3. Local PDF generation via `generateInvoicePdfBlob` (newer path)

**Recommendation:** Replace GAS counter with `LifestyleInvoiceSequence` (year + lastNumber). `InvoiceRecord` remains source of truth for issued invoices. `save_invoice_pdf` GAS path can be retired once Drive upload moves to ERP storage.

---

## 4. Proposed Prisma schema (summary)

Full draft: [`phase0-schema-draft.prisma`](./phase0-schema-draft.prisma)

| Model | Table | Primary key | Notes |
|-------|-------|-------------|-------|
| `LifestyleOrder` | `lifestyle_orders` | `id` String (`AL-XXXX`) | ~45 sheet fields + NOTES meta columns |
| `LifestyleOrderItem` | `lifestyle_order_items` | cuid | Unique `(orderId, lineNo)` |
| `LifestyleProduct` | `lifestyle_products` | `sku` | PRODUCT MASTER (18 rows) |
| `LifestyleStockItem` | `lifestyle_stock_items` | cuid | Unique `(sku, size)` — 541 rows |
| `LifestyleCustomer` | `lifestyle_customers` | `id` String (`CUST-XXXX`) | Unique `(businessId, phone)` |
| `LifestylePromo` | `lifestyle_promos` | cuid | **Placeholder** — promos not live |
| `LifestyleInvoiceSequence` | `lifestyle_invoice_sequences` | `(businessId, year)` | Replaces GAS `AL_INV_COUNTER_*` |

**Money:** `Int` whole taka (matches `roundMoney` / live API integers).  
**Not modeled:** dashboard, analytics, automation log (compute or separate phase).  
**Existing models unchanged:** `InvoiceRecord`, `InvoiceEvent`.

**Computed-on-read (Phase 2 queries, not stored):** `days_pending`, `days_in_transit`, `sla_status`, `margin_pct`, `days_inactive` (customer).

---

## 5. Data volume estimates

| Entity | Rows | Payload size (observed) | Phase 1 import estimate |
|--------|------|-------------------------|-------------------------|
| Orders | 310 | ~25–40 KB JSON/order batch | < 2 min single-threaded |
| Order items | Unknown (≤ few × orders) | Small | < 1 min |
| Stock items | 541 | Large JSON (~MB) | 2–5 min |
| Products | 18 | Tiny | Seconds |
| Customers | 281 | Medium | < 1 min |
| Promos | 0 | — | Skip |
| Invoice sequences | 1/year | 1 row | Seconds |

**Total:** ~1,200 rows — **low complexity** one-time import. Bottleneck is GAS read latency (25s timeouts), not Postgres write volume. Import script should batch reads and verify `COUNT(*)` per table matches sheet `last_row`.

---

## 6. Open questions for Maruf (সিদ্ধান্ত প্রয়োজন)

### A. Order ID format

বর্তমানে order ID `AL-0001` ফরম্যাটে। Postgres-এ migrate করার পরও কি **একই `AL-XXXX` ফরম্যাট** চালিয়ে যাবেন?

- **(A)** হ্যাঁ — পুরনো ID অক্ষত রাখব (`String @id`), নতুন order-ও `AL-0311` থেকে serial  
- **(B)** না — নতুন UUID/CUID, শুধু import mapping table রাখব  
- **(C)** অন্য (নিজের ফরম্যাট লিখুন)

### B. Stock grain

Stock sheet-এ **প্রতি SKU + size আলাদা row** (৫৪১ row)। Schema-তেও কি এটাই রাখব?

- **(A)** হ্যাঁ — `sku + size` unique (বর্তমান sheet-এর মতো)  
- **(B)** না — শুধু product-level, size আলাদা variant table  
- **(C)** অন্য

### C. Promos

Agent code promos route call করে, কিন্তু GAS-এ **promos নেই**। Phase 1-এ কী করব?

- **(A)** Promos বাদ — table/import নেই, agent stub থাকবে  
- **(B)** নতুন promos feature — sheet + GAS বানাবেন, তারপর migrate  
- **(C)** শুধু empty table schema, data পরে

### D. Invoice counter

`next_invoice_num` এখন GAS Script Property-তে। Prisma `InvoiceRecord` ইতিমধ্যে আছে।

- **(A)** GAS counter বাদ — `LifestyleInvoiceSequence` + `InvoiceRecord` একসাথে  
- **(B)** Import পর্যন্ত GAS counter চালু, তারপর cutover  
- **(C)** Invoice number ম্যানুয়াল/অন্য সিস্টেম

### E. Dashboard / analytics

আলাদা table লাগবে না — SQL aggregation যথেষ্ট। একমত?

- **(A)** হ্যাঁ — শুধু Order/Stock table, dashboard query দিয়ে  
- **(B)** না — pre-aggregated snapshot table চাই (দ্রুত load)

### F. Expense ledger (`💸 EXPENSE LEDGER`)

Phase 1 Lifestyle import-এ expense sheet ও নেব?

- **(A)** না — orders/stock/products/customers only (Phase 1 ছোট রাখি)  
- **(B)** হ্যাঁ — finance route-ও একসাথে migrate

### G. Missing GAS routes (`update_product`, `update_customer`)

এগুলো agent থেকে call হয় কিন্তু GAS-এ নেই। Phase 2-তে Postgres API দিয়ে ঠিক করব — prioritise?

- **(A)** হ্যাঁ — agent product/customer edit অগ্রাধিকার  
- **(B)** না — manual ERP UI আগে

### H. Debug / spreadsheet export

Phase 1 import script-এর জন্য exact spreadsheet ID + headers দরকার।

- **(A)** Apps Script editor থেকে সব `.gs` file copy করে repo-তে দেবেন  
- **(B)** `debug` route deploy করবেন  
- **(C)** Spreadsheet ID + screenshot of tab names পাঠাবেন

---

## 7. Proposed Phase 1 scope

Phase 1 will **add approved models to `prisma/schema.prisma`**, run additive migrations on ERP Postgres, and ship a **one-time import script** that reads all rows from GAS (GET `orders`, `stock`, `products`, `customers`, `order` for line items) with per-table row-count verification against live volumes (310 / 541 / 18 / 281). No cutover yet: Next.js continues calling GAS while a feature flag enables **dual-write** (Postgres + GAS) for creates/updates on orders, stock, products, and customers. Invoice sequence seeds from live `next_invoice_num` (`AL-INV-2026-0016` → counter 15). Dashboard/analytics routes stay on GAS until Phase 2 read-path switch. Promos and undeployed mutation routes remain documented gaps. Maruf tests on Vercel preview; merge to main only after row-count checklist passes.

---

## Verification checklist (Phase 0)

| Check | Result |
|-------|--------|
| Only `docs/migration/*` files added | ✅ (this phase) |
| `prisma/schema.prisma` untouched | ✅ |
| `src/` untouched | ✅ |
| Live API: GET only, no POST writes | ✅ |
| GAS secret not printed in report | ✅ |

---

*Generated: 2026-06-14 — Phase 0 discovery for ALMA Lifestyle ERP GAS → Supabase migration.*
