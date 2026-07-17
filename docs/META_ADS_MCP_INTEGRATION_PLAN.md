# Meta Ads MCP Integration Plan — ALMA AI AGENT

**Status:** PLAN — ready for a fresh implementation session
**Written:** 2026-07-17 (triggered by Meta's "Start building today" email to the owner)
**Owner's app:** ALMA AI AGENT (App ID `1990978398451639`) · Business: Alma Online Shop (Business ID `1608376020405591`)
**Goal:** Connect the agent to **Meta's official Ads MCP server** (`https://mcp.facebook.com/ads`) so ALL its capabilities (29 tools) are available inside the existing agent — safely, with the money-touching tools behind the existing approval-card system.

---

## বসের জন্য সারসংক্ষেপ (Bangla)

Meta তাদের বিজ্ঞাপন-সিস্টেমের অফিসিয়াল "AI দরজা" খুলেছে। এই প্ল্যানটা সেটা আপনার এজেন্টের সাথে জোড়া লাগানোর পূর্ণ নকশা — ৪টা ধাপে (MA1–MA4):
1. **MA1:** এক-ক্লিক "Connect Meta Ads" বাটন + শুধু-পড়া টুল (রিপোর্ট/ইনসাইট) — টাকার কোনো ঝুঁকি নেই।
2. **MA2:** এজেন্টের বিদ্যমান মার্কেটিং-ব্রেইনে এই ইনসাইটগুলো ঢোকানো (বুস্ট পরামর্শ, সাপ্তাহিক রিপোর্ট আরও ধারালো)।
3. **MA3:** লেখা-টুল (ক্যাম্পেইন বানানো/বদলানো) — **প্রতিটা টাকা-ছোঁয়া কাজ আপনার Approve-কার্ডের পেছনে**।
4. **MA4:** পুরনো ভঙ্গুর token-নির্ভর অংশ পরিষ্কার + মনিটরিং।
প্রতিটা ধাপ আলাদা branch-এ, kill-switch সহ, আপনার অনুমোদনের পর merge। শুরু করতে: নিচের §9 handoff prompt-টা নতুন session-এ কপি করে দিন।

---

## 1. Verified facts about Meta's Ads MCP (research 2026-07-17)

| Fact | Value |
|---|---|
| Endpoint | `https://mcp.facebook.com/ads` (hosted remote MCP, Streamable HTTP) |
| Tools | **29** across 5 areas: Catalog (10), Insights/Benchmarks (7), Campaign mgmt (5), Dataset/Diagnostics (4), Accounts/Pages (3) |
| Auth | **Meta Business OAuth** dialog; 3 scope tiers — `read-only`, `read/write`, `read/write/financial` — granted per user per ad account; revocable in Business Suite → Business Integrations |
| Tokens | No long-lived tokens to store/rotate (OAuth flow manages) — kills our fb-token-expiry pain class |
| Safety default | Entities created via MCP land **PAUSED**; live activation is a separate explicit step |
| Known limits | No sub-second bid management, no cross-account alerting, no external dashboards |
| CLI companion | Exists (same surface) — **not used** in this plan; CLI creates entities ACTIVE by default (dangerous), MCP creates PAUSED (safe) |

Full tool inventory (names as exposed by the server):
- **Campaign (5):** `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_update_entity`, `ads_activate_entity`
- **Catalog (10):** `ads_catalog_create`, `ads_catalog_get_catalogs`, `ads_catalog_get_details`, `ads_catalog_get_diagnostics`, `ads_catalog_get_feed_rules`, `ads_catalog_get_product_details`, `ads_catalog_get_product_feed_details`, `ads_catalog_get_product_set_products`, `ads_catalog_get_product_sets`, `ads_catalog_get_products`
- **Accounts (3):** `ads_get_ad_accounts`, `ads_get_ad_entities`, `ads_get_pages_for_business`
- **Dataset (4):** `ads_get_dataset_details`, `ads_get_dataset_quality`, `ads_get_dataset_stats`, `ads_get_errors`
- **Insights (7):** `ads_insights_advertiser_context`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`, `ads_insights_industry_benchmark`, `ads_insights_performance_trend`, `ads_get_opportunity_score`, `ads_get_help_article`

---

## 2. Architecture decision (how it fits THIS repo)

The agent becomes an **MCP CLIENT** of Meta's server. Key insight: the repo already speaks MCP wire format — `src/app/api/assistant/mcp/route.ts` implements a Streamable HTTP MCP **server** (JSON-RPC 2.0, protocol `2025-06-18`). The new client reuses that knowledge in reverse.

```
Owner chat → head model (Grok/Gemini) → agent tool registry
                                            │
                              meta-mcp bridge tools (NEW)
                                            │
                          src/agent/lib/meta-mcp/client.ts (NEW, MCP client)
                                            │  Streamable HTTP + OAuth Bearer
                              https://mcp.facebook.com/ads
```

**Locked design choices (follow these, do not re-litigate):**
1. **Bridge, not bypass:** every Meta MCP tool is wrapped as a normal `AgentTool` in the registry, so ALL existing discipline applies automatically — tool-contract validation, capability classification, approval cards, workflow guards, claim-verifier, cost logging, behaviour-parity gates. No separate execution path.
2. **Capability mapping (tool-contract.ts):**
   - all `ads_get_*`, `ads_insights_*`, `ads_catalog_get_*` → `read` / `parallel_read` / approval `none`
   - `ads_catalog_create`, `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_update_entity` → `write` / `sequential` / approval **`staged_card`** (owner Approve required)
   - `ads_activate_entity` → `write` / approval **`before_execute`** + HIGH risk (this is the money switch — Meta creates PAUSED, this tool turns spend ON)
3. **OAuth mirrors the GSC pattern** (`growth/gsc-auth/route.ts` + callback): redirect → consent → callback stores tokens. Meta MCP uses the MCP OAuth 2.1 flow (authorization-server discovery via `/.well-known/oauth-protected-resource` on the MCP endpoint, dynamic client registration if offered, PKCE). Store access/refresh tokens in `agent_kv_settings` (encrypted-at-rest via existing secret handling; keys `meta_mcp_oauth:*`) — **additive, no schema change**.
4. **Scope tier is owner-tunable, starts read-only:** kv `meta_mcp_scope_tier` ∈ `read` | `write` | `financial`. MA1 connects with **read-only**. Upgrading tier = owner re-runs the Connect flow choosing a higher tier. Bridge refuses to register write tools unless tier ≥ write (defense in depth).
5. **Kill switch:** env `META_MCP_ENABLED` (default off) + kv `meta_mcp_enabled` for no-redeploy owner toggle. Every bridge tool checks both. Existing `AGENT_ENABLED` still gates everything upstream.
6. **Timeouts/placement:** MCP calls are short HTTP calls → fine on Vercel routes and inside the turn loop. Batch/scheduled pulls (weekly report enrichment) run on the **VPS worker** like other schedulers. Never a Vercel function waiting on a long job.
7. **Old Graph API stays until MA4:** page posting, Messenger/CS, boosts via existing path keep working untouched. MCP first ADDS capability; replacement is a deliberate last phase with owner sign-off per call-site.
8. **Bangla + guardrails unchanged:** owner-facing output pure Bangla, "Boss" only, existing HEAVY_DENY money-keyword routing still forces the heavy head for spend decisions.

---

## 3. Hard rules (repeat of repo law — the implementing session MUST obey)

- NEVER touch `/api/agent/*` or its auth. New routes ONLY under `/api/assistant/*`; every route checks `requireAgentEnabled()` first, then owner (`getToken` + `isSystemOwner`).
- Agent code only in `src/agent/`, `src/app/agent/`, `src/app/api/assistant/`. ERP code untouched.
- No secrets in git — `.env.example` placeholders only. DB changes: none expected; if unavoidable, additive migration via the existing system.
- Per phase: branch `agent-phase-maN` + tag `pre-agent-phase-maN`; push branch for Vercel preview; owner approves merge. One phase per session.
- Verification per phase: `npm run type-check` + `npx vitest run src/agent` green, `git diff --stat` scope check, **browser proof** (Chrome screenshot on the preview) for every UI-visible piece.

---

## 4. Phase MA1 — OAuth connect + MCP client + read-only tools

**Goal:** owner taps "Connect Meta Ads" once; agent can answer from live Meta insights. Zero write capability.

**New files:**
- `src/agent/lib/meta-mcp/client.ts` — MCP client: `initialize`, `tools/list`, `tools/call` over Streamable HTTP (JSON-RPC 2.0, `MCP-Protocol-Version` header), Bearer auth, 20s timeout, single bounded retry on 429/5xx, typed errors. Mirror the wire handling of `src/app/api/assistant/mcp/route.ts` in reverse.
- `src/agent/lib/meta-mcp/oauth.ts` — discovery, PKCE, token exchange + refresh, kv persistence (`meta_mcp_oauth:tokens`, `meta_mcp_oauth:meta`).
- `src/agent/lib/meta-mcp/bridge.ts` — fetch `tools/list` once per deploy (cache in kv with TTL), wrap each allowed tool as `AgentTool` with: Bangla-annotated description, input schema passthrough, capability per §2.2, and a namespace prefix `meta_ads_` (e.g. `meta_ads_insights_performance_trend`).
- `src/app/api/assistant/meta-mcp/auth/route.ts` + `auth/callback/route.ts` — the GSC-pattern connect flow.
- `src/app/api/assistant/meta-mcp/status/route.ts` — connected? which tier? which ad account? token health.
- `src/agent/tools/meta-ads-tools.ts` — registers the bridged READ tools into the registry (group: `growth`/`marketing` so state-router picks them up on ads intents).
- Tests: `src/agent/lib/meta-mcp/__tests__/client.test.ts` (mocked fetch: initialize/list/call, retry, auth-expiry refresh), `bridge.test.ts` (capability mapping table is exhaustive for all 29 names; write tools NOT registered at read tier).
- UI: a small "Connect Meta Ads" card in the agent settings surface the owner already uses (mirror the GSC/Drive connect buttons’ home) — shows tier + connected account + disconnect.

**Env (`.env.example` additions):** `META_MCP_ENABLED=false`, `META_MCP_ENDPOINT=https://mcp.facebook.com/ads` (override for tests).

**Acceptance:**
- Connect flow completes in the owner's Chrome (browser proof: status card showing "Connected — read-only").
- Owner asks in chat "গত ৭ দিনের অ্যাড পারফরম্যান্স কেমন?" → agent calls a `meta_ads_insights_*` tool live and answers with real numbers (browser proof).
- Write tools are absent from the registry at read tier (test-proven). Type-check + agent suite green.

## 5. Phase MA2 — wire insights into the existing marketing brain

**Goal:** the intelligence the agent already produces gets sharper using official data.

**Work (allowed files):**
- `src/agent/tools/marketing-tools.ts`, `src/agent/tools/ads-tools.ts` — where these currently read performance via raw Graph API, ADD the MCP-backed equivalents (`ads_insights_performance_trend`, `ads_insights_anomaly_signal`, `ads_get_opportunity_score`, benchmarks) as preferred sources with graceful fallback to the old path when MCP is disconnected.
- `src/agent/lib/ads/creative-performance.ts` — enrich with auction/industry benchmarks.
- Weekly strategic + marketing report internals (`internal/marketing-report`, `internal/weekly-strategic-data`) — include anomaly/benchmark context (worker-side batch pulls).
- Catalog read tools surfaced to the head for stock/product-ads questions (`ads_catalog_get_*`).

**Acceptance:** boost recommendation ("বুস্ট করব?") visibly cites live trend + benchmark ("CTR ইন্ডাস্ট্রি গড়ের নিচে…"); weekly report shows an anomaly section; all old paths still work with MCP disabled (kill-switch test). Browser proof of one enriched recommendation.

## 6. Phase MA3 — write tools behind the approval system (money)

**Goal:** owner can say "নতুন ক্যাম্পেইন বানাও ৳X বাজেটে" and the agent drafts it — nothing spends without Approve.

**Work:**
- Owner re-connects at `read/write` (or `financial` for budget edits) — UI offers the tier upgrade.
- `bridge.ts` registers the 5 campaign write tools + `ads_catalog_create` with the §2.2 approval mapping. Each staged card shows: objective, audience summary, daily budget in ৳, duration, and **"তৈরি হবে PAUSED অবস্থায়"**.
- `ads_activate_entity` is its own separate `before_execute` card with a red money warning (this is the switch that starts spend); HEAVY_DENY routing already forces the heavy head on these turns.
- Budget guardrail: kv `meta_mcp_max_daily_budget` (default modest); bridge rejects create/update above it with a Bangla message telling the owner how to raise it. Cost-log every write call.
- Learning-phase guard: warn (don't block) if the same entity's budget/audience was edited in the last 24h.

**Acceptance:** end-to-end in preview — chat request → staged card → Approve → campaign exists in Ads Manager **paused** (browser proof both in chat and Ads Manager); Reject path leaves nothing behind; activation card separately proven; over-budget request politely refused. Suite green.

## 7. Phase MA4 — cutover, cleanup, observability

**Goal:** retire the fragile pieces the MCP now covers; keep what it can't.

**Work:**
- Inventory every direct Graph API ads call; migrate insight/catalog reads to MCP where equivalent; **keep** page posting, Messenger/CS, boost-post path (MCP-র বাইরে) on Graph API.
- `fb-token-health` scope shrinks to what Graph API still serves (document which).
- Status/observability: MCP call counts + error rate + last-success in the existing health surface; ntfy alert on auth expiry (owner gets "আবার Connect চাপুন" message).
- Update `docs/ROUTER_WORKER_ARCHITECTURE.md` with the meta-mcp module.

**Acceptance:** zero remaining duplicate reads; disconnect → clear owner-facing degradation messages, nothing crashes; docs updated; full suite + build green.

---

## 8. Risks & mitigations (honest list)

| Risk | Mitigation |
|---|---|
| Model hallucination → real spend | Read-only first; write tools = staged cards; activation = separate hard card; budget cap kv; PAUSED-by-default server behavior |
| OAuth spec drift (Meta's MCP auth is new) | MA1 isolates ALL auth in `oauth.ts`; if dynamic registration isn't offered, fall back to the owner's existing app credentials (App ID above) — decision recorded in code comments |
| Endpoint/tool list changes (beta) | `tools/list` cached with TTL + bridge tolerates unknown/renamed tools (skips, logs, never crashes registry) |
| Rate limits / 429 | bounded retry + backoff in client; batch pulls on worker schedule, not per-turn |
| Owner revokes access in Business Suite | status route detects, agent answers honestly "Meta Ads সংযোগ বিচ্ছিন্ন — Connect চাপুন", old fallbacks still work |

---

## 9. Handoff prompt (owner: এই অংশটা নতুন session-এ কপি করে দিন)

> Read `docs/META_ADS_MCP_INTEGRATION_PLAN.md` and `CLAUDE.md` fully. Implement **Phase MA1 only** exactly as specified: branch `agent-phase-ma1`, tag `pre-agent-phase-ma1` first. Follow every Hard Rule in §3. Before coding, run the pre-flight: type-check green on a clean checkout, confirm `src/app/api/assistant/mcp/route.ts` and the GSC auth routes exist as pattern references, and `curl -sI https://mcp.facebook.com/ads` reachability from the dev environment. If any pre-flight fails, STOP and report. After implementation: type-check + `vitest run src/agent` + build, `git diff --stat` scope check, push the branch for a Vercel preview, and capture Chrome browser proof of (a) the Connect flow completing and (b) one live insights answer in chat. Do NOT start MA2. Final report per the repo's phase-report format.

---

*Plan only — no integration code written yet. Research sources: Meta announcement email (owner, 2026-07-17); digitalapplied.com 2026 MCP playbook; pillitteri 29-tool inventory; repo audit of `assistant/mcp`, `gsc-auth`, ads/marketing tools.*
