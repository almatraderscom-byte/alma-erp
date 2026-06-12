# PHASE CS-2 — Sales Completion

**Branch:** `agent-cs-2`  
**Tag:** `pre-agent-cs-2`  
**Status:** Ready for Vercel preview + owner testing (no merge to main)

---

## Summary

Final customer-agent phase — closes the sales loop:

1. **FB comment → Messenger** — `feed` webhook, model buying-intent classification, private reply API, optional public reply, post→product mapping
2. **Order lifecycle** — draft → [✅ Confirm] → customer Bangla summary (no delivery dates), `get_customer_order_status`
3. **Follow-ups** — 15-min worker, **23h hard rule** (1h safety margin), price/half-order/post-confirm triggers
4. **Repeat customers** — `cs_customers` per-PSID memory injected into agent context only
5. **Guards + analytics** — rate limit, blocklist, loop handoff, CS section in night/weekly reports, `cs_*` cost kinds

---

## Pre-flight

| Check | Result |
|-------|--------|
| Branch `agent-cs-2` + tag `pre-agent-cs-2` | ✅ |
| `npm run type-check` | ✅ PASS |
| `npm run build` | ✅ PASS |
| `node worker/scripts/test-customer-safe-tools.mjs` | ✅ PASS (7 tools) |
| ERP `orders` table modified | ❌ NO |
| `/api/agent/*` touched | ❌ NO |

---

## Migration

`prisma/migrations/20260617120000_cs2_completion`

New tables: `cs_post_products`, `cs_customers`, `cs_followups`, `cs_comment_replies`, `cs_blocks`, `cs_analytics_events`

Extended: `cs_conversations` (guards, `last_customer_message_at`), `cs_order_drafts` (`confirmed_at`, `cod_amount`, `erp_order_id`)

KV defaults: `cs_public_comment_reply=false`, `cs_followups_enabled=true`

Apply on preview/production when ready:

```bash
npx prisma migrate deploy
```

---

## Meta webhook — `feed` subscription

Re-run on VPS after deploy:

```bash
node worker/scripts/setup-meta-webhook.mjs
```

This registers app + page subscriptions with fields:

`messages`, `messaging_postbacks`, `messaging_optins`, **`feed`**

Manual check (Meta Developers → Webhooks → Page):

- Callback: `https://alma-erp-six.vercel.app/api/assistant/internal/messenger-webhook`
- **feed** subscribed for Lifestyle + Online Shop pages

### Comment flow

1. Customer comments buying intent on post/ad
2. Anthropic classifies intent (not regex)
3. Private reply via `/{comment-id}/private_replies` (max 1 per comment)
4. Dedupe: 1 reply per comment_id + 1 per user per post
5. Shadow mode → `cs_shadow_drafts` + owner notify (same as messenger)
6. Optional public reply if `cs_public_comment_reply=true` (default OFF)

### Post → product mapping

| Method | Command / trigger |
|--------|-------------------|
| Manual | `/postlink <fb post url or id> CODE1 CODE2` |
| Auto-suggest | New page post → visual index → owner one-tap card |

Unmapped post → generic private reply + image match at reply time.

---

## Order lifecycle

| Step | Behaviour |
|------|-----------|
| Draft created | `create_order_draft` → owner Telegram with **[✅ Confirm]** |
| Owner confirms | `cs_confirm:{draftId}` → status `confirmed`, COD summary to customer |
| Customer asks status | `get_customer_order_status({psid})` — CS drafts + ERP by phone only |
| Cancel/change | `handoff_to_human` only — agent changes nothing |

Customer confirm message includes: items, address, COD — **no delivery date promise**.

---

## Follow-ups (24h Meta compliance)

| Item | Detail |
|------|--------|
| Scheduler | `cs-followups` every **15 min** (BullMQ) |
| Hard rule | Send only if `now − lastCustomerMessageAt < 23h` — else `expired` (logged, no send) |
| Triggers | Price no-reply 3–6h; half-order 2h; post-confirm thank-you 30m |
| Cap | Max 1 follow-up per type per conversation per Dhaka day |
| Toggle | `/cs followups on\|off` |

**Compliance proof:** `cs_followups` rows with `status=expired` + `cs_analytics_events` kind `followup_expired` include `ageHours` in metadata when window exceeded.

---

## Repeat customer memory

Table `cs_customers` — updated on order confirm. Injected into CS system prompt per conversation only. Never shared across customers or owner memory.

---

## Guards

| Guard | Behaviour |
|-------|-----------|
| Rate limit | 30 agent replies/day per conversation → polite pause + owner alert |
| Abuse | One warning, then silent + alert |
| Blocklist | `/cs block <psid>` |
| Loop breaker | Same question 4+ times → handoff |

---

## Analytics

- Events: `cs_analytics_events` (comment_capture, draft_created, draft_confirmed, followup_*, product_asked, …)
- API: `GET /api/assistant/internal/cs-analytics?days=7`
- Night report (daily) + Friday weekly review include CS section
- Cost dashboard: `csByKind` breakdown (`cs_chat`, `cs_vision`, `cs_comment_classify`)

### Sample (empty DB)

```json
{
  "conversations": 0,
  "commentCaptures": 0,
  "draftsCreated": 0,
  "draftsConfirmed": 0,
  "conversionChatToDraft": 0,
  "followupsExpired": 0
}
```

---

## Telegram commands (owner)

```
/cs off|shadow|night|auto|status|resume <id>
/cs followups on|off
/cs block <psid>
/postlink <post> CODE1 CODE2
```

---

## Live test matrix

| Test | Expected |
|------|----------|
| Comment "দাম কত?" on mapped post | Private reply in Messenger with product price |
| `/postlink` | `cs_post_products` row created |
| Order draft → [✅ Confirm] | Customer gets Bangla summary, no date promise |
| Status query | `get_customer_order_status` returns real ERP/CS status |
| Follow-up inside 23h | Message sent, `cs_followups.status=sent` |
| Follow-up after 23h | `status=expired`, **no** Messenger send (check logs) |
| Repeat customer | Greeting mentions remembered size (re-confirms) |
| Rate limit / block | Pause or silence + owner alert |
| Analytics | Night report CS section after test events |

---

## CUSTOMER_SAFE_TOOLS (7)

`match_product_by_image`, `search_products`, `get_product_details`, `send_product_image`, `create_order_draft`, **`get_customer_order_status`**, `handoff_to_human`

---

## FINAL traceability CS-0 → CS-2

| Requirement | CS-0 | CS-1 | CS-2 |
|-------------|------|------|------|
| Product images + visual index | ✅ | ✅ | ✅ |
| Size charts | ✅ | ✅ | ✅ |
| CUSTOMER_SAFE_TOOLS isolation | — | ✅ | ✅ (7 tools) |
| Messenger webhook real-time | — | ✅ | ✅ + feed |
| Image → product match | — | ✅ | ✅ |
| Shadow mode drafts | — | ✅ | ✅ + comment drafts |
| Order drafts (not ERP orders) | — | ✅ | ✅ |
| Draft → confirmed lifecycle | — | ❌ | ✅ |
| Order status queries | — | ❌ | ✅ |
| FB comment capture | — | ❌ | ✅ |
| Post → product link | — | ❌ | ✅ |
| Follow-ups (24h compliant) | — | ❌ | ✅ |
| Repeat customer memory | — | ❌ | ✅ |
| Abuse guards | — | ❌ | ✅ |
| CS analytics in reports | — | ❌ | ✅ |
| No delivery date promises | — | ✅ | ✅ |
| Handoff rules unchanged | — | ✅ | ✅ |
| Prices from inventory only | ✅ | ✅ | ✅ |

---

## Deploy checklist (owner)

1. Merge preview after testing
2. `npx prisma migrate deploy` (production DB)
3. Vercel env unchanged (META_* already set from CS-1)
4. VPS: `git pull && pm2 restart agent-worker`
5. `node worker/scripts/setup-meta-webhook.mjs` (adds `feed`)
6. `/cs shadow` → run live matrix above
7. `/cs auto` when satisfied
