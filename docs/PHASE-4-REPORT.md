# Phase 4 Report — ERP Tools, Confirm Cards, VPS Worker, Image Gen, FB Posting

**Date:** 2026-06-11  
**Branch:** `agent-phase-4`  
**Prerequisite:** Phase 3 (memory/RAG) merged into `main`

---

## What Was Built

### Part 1 — Pre-flight
- `.env.example` additions: `AGENT_INTERNAL_TOKEN`, `FB_PAGE_TOKEN_LIFESTYLE`, `FB_PAGE_TOKEN_ONLINESHOP`
- `worker/scripts/check-fb-token.mjs` — verifies Meta page tokens + scopes before going live

### Part 2 — ERP Read Tools (7 new tools)
All tools return `{success, data, error}` and use existing `agent-api` services (no duplication).

| Tool | Wraps | Purpose |
|------|-------|---------|
| `get_sales_summary` | `listAgentOrders` + `buildOrdersSummary` | Revenue/order count for any date range |
| `get_orders` | `listAgentOrders` | Order list with status/date filters |
| `get_inventory_status` | `listInventory` | Stock levels; `lowStockOnly` filter |
| `get_product` | `listProducts` | Product search by name/SKU |
| `get_customer_summary` | `listCustomers` | Top buyers by spend, new vs returning |
| `get_employee_overview` | `listEmployees` + Prisma | Roster + pending advances + fine aggregate |
| `get_dashboard_snapshot` | `getAgentOrdersSummary('today')` + Prisma | Today's orders, revenue, pending counts |

System prompt updated with business data rules:  
- "Answer from tool data only — never guess"  
- All amounts shown in whole-taka (৳)

### Part 3 — Confirmation Card System

**New DB table:** `agent_pending_actions`  
Fields: id, conversationId, type, payload (JSONB), summary, costEstimate, status, createdAt, resolvedAt, result

**Status flow:** `pending` → `approved` | `rejected` → `executed` | `failed` | `expired` (30 min)

**Privileged tools** (image gen, FB post) create a pending action instead of executing directly.  
The SSE stream emits a new `confirm_card` event → UI shows **Approve / Reject** buttons inline.

**New API routes:**
- `POST /api/assistant/actions/[id]/approve` — executes inline (FB post) or marks approved (image gen)
- `POST /api/assistant/actions/[id]/reject` — marks rejected, appends note to conversation

### Part 4 — VPS Worker

**Location:** `worker/` directory (standalone Node.js ES module app)

- BullMQ + ioredis queues: `image-gen`, `long-agent-task`
- **No BullMQ dependency in the Next.js app** — clean separation.  
  The worker polls `GET /api/assistant/internal/pending-jobs` (token-authenticated) every 30 seconds, then enqueues via its local BullMQ queue for durable retry handling.
- Results reported back via `POST /api/assistant/internal/job-result` (Bearer `AGENT_INTERNAL_TOKEN`)
- GitHub Actions: `.github/workflows/deploy-worker.yml` — auto-deploys on push to `main` touching `worker/**`

**Setup:** See `worker/SETUP.md` for copy-paste Ubuntu install block.

**GitHub secrets to add** (Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | VPS IP (e.g. `31.97.237.40`) |
| `VPS_SSH_KEY` | Private SSH key for VPS login |

### Part 5 — Image Generation (Nano Banana)

- Tool `generate_image({prompt, quality, referenceImageId?})` → confirm card
- On approve: worker calls Google Gemini (`gemini-3-pro-image-preview` for `pro`, `gemini-3.1-flash-image-preview` for `standard`)
- Reference image: fetched from Supabase `agent-files` bucket, passed as inline data
- Result: uploaded to `agent-files/generated/{actionId}.{ext}`, public URL posted back to conversation
- Cost estimate shown on confirm card: ৳4.50 (pro) / ৳1.10 (standard)

### Part 6 — Facebook Posting

- `src/agent/lib/meta.ts` — minimal Graph API v21.0 client (no SDK)
- Tool `post_to_facebook({page, message, imageArtifactOrFileId?})` → confirm card (always)
  - On approve: executes inline, self-verifies via `GET /{postId}?fields=id`
  - Success/failure appended to conversation
- Tool `get_fb_recent_posts({page, limit})` — direct read, no confirmation
- Pages: `lifestyle` → `1044848232034171`, `onlineshop` → `827260860637393`

**Token pre-flight check:**
```bash
cd worker
FB_PAGE_TOKEN_LIFESTYLE=xxx FB_PAGE_TOKEN_ONLINESHOP=yyy node scripts/check-fb-token.mjs
```

---

## Files Created / Modified

### New Files (16)
```
prisma/migrations/20260611000000_agent_pending_actions/migration.sql
src/agent/tools/erp-tools.ts
src/agent/tools/confirm-tools.ts
src/agent/lib/meta.ts
src/agent/components/AgentConfirmCard.tsx
src/app/api/assistant/actions/[id]/approve/route.ts
src/app/api/assistant/actions/[id]/reject/route.ts
src/app/api/assistant/internal/job-result/route.ts
src/app/api/assistant/internal/pending-jobs/route.ts
worker/package.json
worker/src/index.mjs
worker/scripts/check-fb-token.mjs
worker/SETUP.md
.github/workflows/deploy-worker.yml
docs/PHASE-4-REPORT.md
```

### Modified Files (7)
```
prisma/schema.prisma          — AgentPendingAction model added
src/agent/tools/registry.ts   — ERP_TOOLS + CONFIRM_TOOLS imported
src/agent/lib/core.ts         — confirm_card AgentEvent + emit after tool_end
src/agent/lib/system-prompt.ts — Business data rules + confirm card instructions
src/agent/components/AgentApp.tsx  — confirm_card SSE handler
src/agent/components/AgentThread.tsx — pendingAction on ChatMessage + confirm card render
.env.example                  — 3 new placeholders
```

---

## Verification Checklist

| Check | Status |
|-------|--------|
| `next build` passes | ✅ PASS |
| Zero new ERP files modified | ✅ PASS |
| Migration is additive only | ✅ PASS |
| BullMQ not in main app dependencies | ✅ PASS |
| Internal routes require AGENT_INTERNAL_TOKEN | ✅ PASS |
| All new routes check AGENT_ENABLED first | ✅ PASS |
| FB post always requires confirm card | ✅ PASS |
| Image gen always requires confirm card | ✅ PASS |
| Confirm card expires after 30 min | ✅ PASS |
| FB post self-verify implemented | ✅ PASS |
| Worker deploy via GitHub Actions | ✅ PASS |
| FB token pre-flight script | ✅ PASS |

---

## Decisions & Ambiguities

1. **BullMQ in main app**: Chose poll-based job discovery (`/internal/pending-jobs`) instead of pushing from Next.js to BullMQ. This keeps BullMQ entirely in `worker/` and avoids webpack bundling issues. BullMQ still provides durable retry on the worker side.

2. **`get_employee_overview` salary**: Returns name/role/active only. Aggregate fines and pending advances count — no individual salary figures per prompt spec.

3. **`generate_image` cost estimates**: ৳4.50 (pro) / ৳1.10 (standard) are placeholders. Owner should update in `confirm-tools.ts` once actual Gemini billing is confirmed.

4. **Google Gemini model names**: `gemini-3-pro-image-preview` and `gemini-3.1-flash-image-preview` as specified in the phase prompt. If these model IDs change when generally available, update `worker/src/index.mjs`.

5. **Confirm card on page reload**: The `pendingAction` is only on the live streaming message (not restored on reload). For active pending actions, the owner can check back within 30 min or re-request. Expired actions are cleanly rejected.

---

## VPS One-Time Setup (Copy-Paste)

See **`worker/SETUP.md`** for the full Ubuntu setup block. Summary:

```bash
# On VPS:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs redis-server
sudo npm install -g pm2
git clone https://github.com/almatraderscom-byte/alma-erp.git /opt/alma-erp
cd /opt/alma-erp/worker && npm ci
# Edit .env with all required values
pm2 start src/index.mjs --name alma-agent-worker --interpreter node && pm2 save
```
