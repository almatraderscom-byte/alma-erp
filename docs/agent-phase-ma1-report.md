# Phase MA1 Report — Meta Ads MCP: OAuth connect + client + read-only tools

**Branch:** `agent-phase-ma1` (tag `pre-agent-phase-ma1` = main @ c80b1d8c) · **Date:** 2026-07-17
**Plan:** `docs/META_ADS_MCP_INTEGRATION_PLAN.md` §4 — implemented exactly; MA2 not started.

## Files created

| File | What it is |
|---|---|
| `src/agent/lib/meta-mcp/oauth.ts` | OAuth 2.1: RFC 9728/8414 discovery (kv-cached), dynamic client registration (RFC 7591, fallback = ALMA AI AGENT app id / `META_MCP_CLIENT_ID` env), PKCE S256 with state stored in `agent_kv_settings` (serverless-safe), token exchange + refresh, tier scopes (kv `meta_mcp_scope_tier`, default **read**), kill-switch helpers (`META_MCP_ENABLED` env AND kv `meta_mcp_enabled`) |
| `src/agent/lib/meta-mcp/client.ts` | MCP Streamable HTTP client: initialize → notifications/initialized → tools/list \| tools/call; `MCP-Protocol-Version: 2025-06-18`, Bearer auth, 20s timeout, ONE bounded retry on 429/5xx/network, ONE 401 token-refresh replay, session-id handling + re-init on expiry, JSON **and** SSE single-response parsing, typed `MetaMcpError` |
| `src/agent/lib/meta-mcp/bridge.ts` | Exhaustive capability map for **all 29** remote tools (§2.2 mapping: reads free; creates/updates `staged_card`; `ads_activate_entity` `before_execute` + HIGH). MA1 wraps ONLY the 23 read tools as AgentTools (`meta_` prefix) + `meta_ads_list_tools` (live tool inventory with exact schemas). Strict-root schema with free-form `args` passthrough; tools/list kv-cached 6h; unknown/renamed remote tools degrade gracefully (never crash the registry) |
| `src/agent/tools/meta-ads-tools.ts` | Registers the bridged read tools (dormant + kill-switched, like WA_TOOLS) |
| `src/app/api/assistant/meta-mcp/auth/route.ts` + `auth/callback/route.ts` | GSC-pattern connect flow (owner-only, `requireAgentEnabled` first) |
| `src/app/api/assistant/meta-mcp/status/route.ts` | connected? tier? token health? ad accounts (live probe, best-effort)? + DELETE = disconnect |
| Tests: `src/agent/lib/meta-mcp/__tests__/{client,bridge,oauth}.test.ts` | 29 tests: wire contract, bounded retry, 401 recovery, SSE, capability-map exhaustiveness (29 names), **write tools absent at read tier**, kill-switch/not-connected degradation, RFC 8414 path-aware discovery |

**Modified (agent-scope only):** `registry.ts` + `tool-groups.ts` (growth group), `capability-classification.ts` (24 read entries, domain `meta_ads`), `GrowthConnections.tsx` (Connect Meta Ads card), `.env.example` (`META_MCP_ENABLED=false`, `META_MCP_ENDPOINT`, optional client id/secret).

## Migrations added

**None** — tokens/state ride in existing `agent_kv_settings` (additive keys `meta_mcp_*`).

## Verification checklist

| Check | Result |
|---|---|
| Pre-flight: type-check clean checkout, pattern refs exist, endpoint reachable | **PASS** (401 + oauth-protected-resource header, as planned) |
| `npm run type-check` | **PASS** |
| `npx vitest run src/agent` | **PASS — 1879/1879** (150 files, incl. capability-manifest coverage of new tools) |
| `npm run build` | **PASS** (3 new routes emitted) |
| `git diff --stat` scope check | **PASS** — agent files + `.env.example` only; zero ERP files; `/api/agent/*` untouched |
| Write tools absent from registry at read tier | **PASS** (test-proven, bridge.test.ts) |
| Live OAuth discovery against Meta | **PASS** — found+fixed RFC 8414 path-aware URL; Meta offers dynamic client registration, PKCE S256, refresh tokens |
| Preview deploy | **PASS — READY**; meta-mcp routes live, correctly 401 without owner session |
| Browser proof (a) Connect flow | **PASS** — owner connected live on the preview (Chrome-MCP screenshots): card shows **"যুক্ত আছে ✓ — read-only"**; token stored in kv; token verified VALID against Graph API (listed the owner's 3 ad accounts) |
| Browser proof (b) live insights answer via MCP | **BLOCKED BY META** — see below; not a code defect |

## Live findings (2026-07-17) — final state after Meta's own-app onboarding

The blocker chain was solved LIVE during the session, each step proven:
1. Dynamic client registration is refused for third parties — **the app-id fallback is the sanctioned path** (Meta doc: pass your app id as OAuth client id).
2. `ads_mcp_management` requires the **"Create & manage ads with ads MCP server" use case** on the app (found via Meta's "Start building today" email → get-started doc). Owner added it to ALMA AI AGENT; the consent dialog then accepts the scope (verified).
3. Owner reconnected read-only: **the MCP connection is LIVE** — `tools/list` returns **82 tools** (all 29 plan names present + 53 new since the plan), and `ads_get_ad_accounts` returns real account data through the MCP.
4. **Remaining Meta gate — per-ad-account rollout:** every insights call answers `is_ads_mcp_enabled: false` / "Ads MCP is gradually being rolled out. Please check back at a later date." on all 3 of the owner's ad accounts (incl. act_1236291335314468 where the live $11.48 campaign ran). Nothing user-side can force this; the bridge surfaces Meta's message verbatim and degrades gracefully.

## Live-found agent bug (pre-existing, NOT introduced by MA1 — fix awaits owner approval)

Acceptance chat test ("গত ৭ দিনের অ্যাড পারফরম্যান্স কেমন?") exposed: the head answered from **`growth_control_room`** (old Graph path) while CLAIMING "Meta MCP থেকে লাইভ চেক", and reported spend **৳0** — Ads Manager truth was **$11.48 / 49,801 impressions** in act_1236291335314468. Two defects: (a) old ads tools read the wrong/default ad account; (b) false source attribution the claim-verifier didn't catch. Proposed fixes (owner approval pending, MA2 scope): correct ad-account resolution for the legacy ads tools + source-claim honesty check.

**Consequences:** MA1's surface is fully built, kill-switched, and proven to the deepest point Meta currently allows. When Meta flips `is_ads_mcp_enabled` for the accounts, insights flow with zero further code. MA2 proceeds with Graph-API-preferred sources and the account-resolution fix above.

## Ambiguities + decisions made

- **Meta's AS identifier carries a path** (`https://mcp.facebook.com/ads`): metadata lives ONLY at the RFC 8414 path-aware URL — first implementation missed this; caught by live-testing, fixed, regression-tested.
- **Strict-schema law vs schema passthrough:** repo Phase-2 contract requires every schema root to reject unknown fields; Meta owns the real schemas. Resolution: single free-form `args` object under a strict root (nested objects stay permissive by design), plus `meta_ads_list_tools` so the head can read Meta's exact live schemas. No global guard weakened.
- **Tier→scope mapping** authored from the endpoint's advertised scope set; read tier excludes every `*_management` scope that can mutate ads/catalogs. Financial = write scopes (the financial grant happens inside Meta's dialog, per plan §1).
- **kv half of kill switch defaults ON** (env is the master, default OFF) so the owner can disable without redeploy but a fresh deploy isn't dead by a missing kv row.
