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

## Live finding (2026-07-17): Meta's MCP is closed to third-party clients today

Proven chain, each step live-tested:
1. Dynamic client registration → `400 invalid_client_metadata: "Dynamic registration is not available for this client"`.
2. Classic app requesting `ads_mcp_management` → dialog rejects: "Invalid Scopes" (scope is internal to Meta's own pre-registered MCP clients — claude.ai/ChatGPT).
3. Owner's app WITHOUT that scope → OAuth completes, token valid on Graph API (`/me/adaccounts` returns 3 accounts), but `mcp.facebook.com/ads` answers `401 {"title":"This resource is restricted to certain users…"}`.
4. Same wall hit by Claude Code CLI (anthropics/claude-code#55002, #57191, #58054) and OpenAI Codex (openai/codex#24103) — no user-side workaround as of July 2026; the fix must come from Meta (client allowlist / `is_ads_mcp_enabled` rollout).

**Consequences:** MA1's own surface is fully built, kill-switched, and proven up to Meta's gate. The bridge works the day Meta opens third-party access — zero further code needed on the happy path. Old Graph-API ads tools are untouched and keep serving insights (the connect token itself already works there). MA2 can proceed with Graph-API-preferred sources; the MCP-preferred switch stays ready behind the same tools.

**Owner follow-ups (no urgency):** check the "Start building today" email for any business-onboarding/allowlist link for Ads MCP; alternatively the owner can connect claude.ai's own Meta Ads connector for personal use — that path uses Meta's whitelisted client and works today.

## Ambiguities + decisions made

- **Meta's AS identifier carries a path** (`https://mcp.facebook.com/ads`): metadata lives ONLY at the RFC 8414 path-aware URL — first implementation missed this; caught by live-testing, fixed, regression-tested.
- **Strict-schema law vs schema passthrough:** repo Phase-2 contract requires every schema root to reject unknown fields; Meta owns the real schemas. Resolution: single free-form `args` object under a strict root (nested objects stay permissive by design), plus `meta_ads_list_tools` so the head can read Meta's exact live schemas. No global guard weakened.
- **Tier→scope mapping** authored from the endpoint's advertised scope set; read tier excludes every `*_management` scope that can mutate ads/catalogs. Financial = write scopes (the financial grant happens inside Meta's dialog, per plan §1).
- **kv half of kill switch defaults ON** (env is the master, default OFF) so the owner can disable without redeploy but a fresh deploy isn't dead by a missing kv row.
