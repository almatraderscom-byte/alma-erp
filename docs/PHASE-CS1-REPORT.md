# PHASE CS-1 — Customer Messenger Sales Agent

**Branch:** `agent-cs-1`  
**Tag:** `pre-agent-cs-1`  
**Status:** Ready for Vercel preview + owner testing (default `cs_mode=off`)

---

## Summary

Customer-facing Messenger agent for Alma Lifestyle + Alma Online Shop:

- Real-time Meta webhook inbound (not 15-min poll)
- Image → product matching via Gemini Flash + pgvector + Sonnet vision
- `CUSTOMER_SAFE_TOOLS` registry — hard-isolated from owner ERP/finance/salah tools
- Shadow mode first (`cs_mode=shadow`) with [📤 পাঠাও] [✏️] Telegram approval
- Order drafts in **`cs_order_drafts`** (ERP `orders` table **not touched** — no safe draft state)
- Human handoff + escalation ladder (10m / 15m / 25m)

---

## Pre-flight

| Check | Result |
|-------|--------|
| Branch `agent-cs-1` + tag `pre-agent-cs-1` | ✅ |
| `npm run type-check` | ✅ PASS |
| `npm run build` | ✅ PASS |
| `node worker/scripts/test-customer-safe-tools.mjs` | ✅ PASS |
| ERP orders table modified | ❌ NO — uses `cs_order_drafts` |
| Owner agent `/api/agent/*` touched | ❌ NO |

---

## Inventory images (CS-0 baseline)

Product codes = `StockItem.sku`. Images in `product_images` (CS-0), **not** legacy `StockItem.imageUrl`.

Run after deploy:

```bash
# Via Telegram (owner): /catalog status
# Or internal API when worker is up
```

**Indexing:** Only products with a row in `product_images` are indexed into `product_visual_index`. Products without images fall back to **text-only** `search_products`.

Manual / nightly index:

```bash
node worker/scripts/trigger.mjs cs-index-products
```

---

## Meta webhook setup (owner)

1. [Meta Developers](https://developers.facebook.com/) → your app → **Webhooks**
2. Callback URL: `https://alma-erp-six.vercel.app/api/assistant/internal/messenger-webhook`
3. Verify token: same as Vercel env `META_WEBHOOK_VERIFY_TOKEN`
4. Subscribe **messages** for both pages (Lifestyle `1044848232034171`, Online Shop `827260860637393`)
5. Vercel env (Production + Preview):
   - `META_APP_SECRET` — app secret (signature validation)
   - `META_WEBHOOK_VERIFY_TOKEN` — your chosen verify string
   - `AGENT_ENABLED=true` (when ready to test)
6. Existing `FB_PAGE_TOKEN_LIFESTYLE` / `FB_PAGE_TOKEN_ONLINESHOP` unchanged

---

## CS modes (Telegram owner)

| Command | Mode | Behaviour |
|---------|------|-----------|
| `/cs off` | off | Webhook stores messages only; no auto-reply |
| `/cs shadow` | shadow | Agent drafts → Eyafi/owner Telegram [📤 পাঠাও] |
| `/cs night` | auto_night | Auto 22:00–09:00 Dhaka; shadow otherwise |
| `/cs auto` | auto | Full auto (handoffs still apply) |
| `/cs status` | — | Show current mode |
| `/cs resume <id>` | — | Resume CS after human handoff |

Default DB: `agent_kv_settings.cs_mode = off`

---

## Shadow escalation ladder

| Time | Action |
|------|--------|
| 10 min | Reminder to Eyafi (staff Telegram) |
| 15 min | Owner Tier 1 + [📤 পাঠাও] [✏️] |
| 25 min | Owner Tier 2 critical ("কাস্টমার অপেক্ষায়") |

Scheduler: `cs-escalation` every minute. Night report can include missed drafts (hook in daily ops).

---

## CUSTOMER_SAFE_TOOLS (exact set)

1. `match_product_by_image`
2. `search_products`
3. `get_product_details`
4. `send_product_image`
5. `create_order_draft` → `cs_order_drafts`
6. `handoff_to_human`

Unit test: `worker/scripts/test-customer-safe-tools.mjs`

---

## Persona prompt (full text — owner review)

See `src/agent/lib/cs/customer-prompt.ts` → `CS_CUSTOMER_SYSTEM_PROMPT`:

- Warm Dhaka shop-assistant Bangla
- Short natural sentences; mirror customer language
- Max 1 emoji per message
- Prices/stock **only** from tools — never invent
- Never ask for product code
- Honest about being ALMA digital assistant
- No owner/finance/staff/internal data
- Fixed price on bargaining; no discounts unless `cs_discount_policy` KV exists
- Handoff triggers: anger, payment/refund, "মানুষ", 2× failed image match, etc.

---

## Architecture

```
Customer FB message
  → POST /api/assistant/internal/messenger-webhook (signed)
  → cs_messages + cs_reply_jobs
  → Worker BullMQ cs-reply queue (poll 10s)
  → POST /api/assistant/internal/cs-run
  → runCsTurn (CUSTOMER_SAFE_TOOLS only)
  → shadow: cs_shadow_drafts + Telegram
  → auto: Meta Send API (typing_on + 2–4s delay)
```

Messenger 15-min scan: skips conversations where CS replied in last 2h (`cs-is-handled`).

---

## Migrations

`prisma/migrations/20260616120000_cs1_customer_sales/migration.sql`

Tables: `cs_conversations`, `cs_messages`, `product_visual_index`, `cs_order_drafts`, `cs_shadow_drafts`, `cs_reply_jobs`

**Apply on Supabase before enabling CS.**

---

## Verification checklist (owner)

| Test | Shadow | Expected |
|------|--------|----------|
| Text price query | ✅ | Correct ৳ from inventory |
| Known product image | ✅ | Match + product photo back |
| Unknown image | ✅ | Graceful + owner alert / handoff |
| Order flow | ✅ | `cs_order_drafts` row + Eyafi notify |
| "মানুষ দিন" | ✅ | Handoff; CS silent until `/cs resume` |
| Ask owner expenses | ✅ | Polite deflection |
| Webhook latency | ✅ | Target <10s end-to-end |
| Messenger scan | ✅ | No false alert on CS-handled chat |

---

## Cost

Logged to `agent_cost_events`:

- `kind: cs_chat` (Anthropic)
- `kind: cs_vision` (Gemini Flash)
- `kind: embedding` (OpenAI, index + match)

Measure per test conversation from cost dashboard after shadow run.

---

## Rollout recommendation

1. Apply migration
2. Set webhook + env vars
3. `node worker/scripts/trigger.mjs cs-index-products` (index catalog images)
4. `/cs shadow` — test from personal FB account on both pages
5. Review drafts 1 week; fix persona gaps
6. `/cs night` then `/cs auto` when confident

**Do not merge to main until owner approves preview.**

---

## Files created / modified (scope)

**New:** `src/agent/lib/cs/*`, `src/agent/tools/cs-tools.ts`, `src/agent/tools/cs-registry.ts`, internal routes (`messenger-webhook`, `cs-run`, `cs-pending-replies`, `cs-index-products`, `cs-is-handled`, `cs-shadow-draft`, `cs-escalation`, `cs-resume`), `worker/src/cs/*`, migration, test script.

**Modified:** `prisma/schema.prisma`, `worker/src/index.mjs`, `worker/src/schedulers/index.mjs`, `worker/src/messenger/scan.mjs`, `worker/src/telegram/index.mjs`, `worker/scripts/trigger.mjs`, `.env.example`, `src/agent/lib/pricing.ts` (cost kinds).
