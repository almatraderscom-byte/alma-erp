# PHASE CS-0 — Catalog Preparation Report

**Branch:** `agent-cs-0` · **Tag:** `pre-agent-cs-0`  
**Date:** 2026-05-24

## Inventory schema (detected)

| Field | Source | Notes |
|-------|--------|-------|
| Product code | `StockItem.sku` | Case/space normalized to uppercase, `_` → `-` |
| Name | `StockItem.product` | Used for role guessing (baba/chele/ma/meye) |
| Category | `StockItem.category` | Size-chart category mapping |
| Size / variant | `size`, `sizeValue`, `sizeCategory`, `genderType`, `collectionType` | One stock row per SKU; `get_size_for_age` checks stock on matching `sizeValue` |
| Business | `DEFAULT_AGENT_BUSINESS_ID` (`ALMA_LIFESTYLE`) | Stored on all CS-0 tables |
| Images (ERP) | `StockItem.imageUrl` (optional) | **Unused today** — CS-0 uses new `product_images` table |

**No existing inventory tables were modified.** `git diff` touches only `prisma/schema.prisma` (additive models), `src/agent/*`, `src/app/api/assistant/internal/catalog/*`, `worker/*`, and `docs/`.

## Additive schema

- `product_images` — catalog photos per SKU
- `cs_design_groups` + `cs_design_group_members` — family-matching design groups
- `cs_size_charts` — age → sizeLabel per category

Migration: `prisma/migrations/20260615120000_cs0_catalog/migration.sql`

## Features delivered

### Part 1 — Product images (Telegram + bulk)

- Photo + caption `FM-204` → validates SKU, uploads to `agent-files` bucket `product-images/<business>/<code>/<n>.jpg`, first image = `isPrimary`
- Album with one caption → all photos attach to that code
- Caption `CODE delete` → owner confirm card → deletes all images for code
- `/catalog status` — totals + top 10 missing (prioritized by recent order line SKUs)
- Staff + owner may upload; delete owner-only
- Bulk: `node worker/scripts/import-product-images.mjs <dir>` (`CODE.jpg`, `CODE-2.jpg`)

### Part 2 — Design groups

- `/group FM-204 FM-205 Family Panjabi Eid` — creates/extends group, auto role from name
- `/group set FM-205 chele` — fix role
- Photo caption `FM-204 FM-205 group Eid Family` — images + group in one step
- `/catalog suggest` — owner approval cards (✅/❌), no auto-group without approval
- Tools: `get_design_group`, `get_size_for_age` in `TOOLS` + `STAFF_SAFE_TOOLS`

### Part 3 — Age → size charts

- `/sizechart add boys_panjabi 4-5 26`, `list`, `delete <id>`
- Seed: `worker/data/size-charts.seed.json`
- Import: `node worker/scripts/trigger.mjs import-size-charts`
- `get_size_for_age` — maps product → category; `chart_missing` when no data (agent must ask owner)

### CS-1 note (paste into CS-1 prompt)

> Product images live in the `product_images` table from CS-0; design groups in `cs_design_groups`; index at design-group level.

### Persona guidance (CS-1 sizing)

Ask age naturally like a shopkeeper ("বাবুর বয়স কত ভাইয়া?"), one question at a time. Adults → usual size or height. Use `get_size_for_age`; never guess if `chart_missing`. Confirm: "৬ বছরের জন্য সাইজ ২৮ পারফেক্ট হবে ইনশাআল্লাহ".

## ছবি যোগ করার নিয়ম (Eyafi / staff — forward করুন)

1. টেলিগ্রামে বটে **ফটো** পাঠান — ক্যাপশনে শুধু প্রোডাক্ট কোড (যেমন `FM-204`)।
2. এক অ্যালবামে এক ক্যাপশন — সব ছবি ওই কোডে যুক্ত হবে।
3. ফ্যামিলি সেট: `FM-204 FM-205 group Eid Family` — ছবি + গ্রুপ একসাথে।
4. অগ্রগতি দেখতে: `/catalog status`
5. ভুল কোড হলে বট কাছাকাছি ২টা কোড সাজেস্ট করবে।

## Verification checklist

| Check | Status |
|-------|--------|
| `npm run build` | PASS |
| Additive migration only | PASS |
| ERP inventory tables untouched | PASS (asserted via diff) |
| Telegram photo + valid code | Requires live bot + migrated DB |
| Invalid code fuzzy suggest | Implemented |
| `/group` + `get_design_group` | Implemented |
| `/sizechart` + `get_size_for_age` | Implemented |
| `chart_missing` path | Returns `{ success: false, reason: 'chart_missing' }` |

## Grouping suggestions

Run `/catalog suggest` on production after deploy. Heuristics: shared `collectionType`/name stem, shared SKU prefix. Owner must tap ✅ before groups are created.

## Files (main)

- `src/agent/lib/catalog/*` — inventory lookup, images, groups, size charts, suggestions
- `src/agent/tools/catalog-tools.ts`
- `src/app/api/assistant/internal/catalog/*`
- `worker/src/telegram/catalog.mjs`
- `worker/scripts/import-product-images.mjs`
- `worker/data/size-charts.seed.json`
