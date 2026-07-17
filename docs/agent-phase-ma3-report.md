# Phase MA3 Report — Meta Ads MCP write tools behind the approval system

**Branch:** `agent-phase-ma3` (tag `pre-agent-phase-ma3` = main @ 59dda227, i.e. MA1+MA2 merged) · **Date:** 2026-07-17
**Plan:** `docs/META_ADS_MCP_INTEGRATION_PLAN.md` §6 — implemented; MA4 not started.

## Files

| File | What |
|---|---|
| `src/agent/tools/meta-ads-write-tools.ts` (NEW) | 6 staged write tools: `meta_ads_create_campaign/create_ad_set/create_ad/update_entity/catalog_create` (staged_card) + `meta_ads_activate_entity` (before_execute, 🔴 spend switch). Each is TRIPLE-gated — kill switch + connection + write tier — then stages an `agentPendingAction` (`type: meta_ads:<remote>`). Budget guardrail + 24h learning-phase warn. |
| `actions/[id]/approve/route.ts` (edit) | Executor branch for `meta_ads:*` — claim → `metaMcpCallTool(remote, args)` → executed/failed + telemetry + Bangla note. Meta creates PAUSED; only activate starts spend. |
| `meta-mcp/oauth.ts` (edit) | `getMetaMcpMaxDailyBudget()` + kv `meta_mcp_max_daily_budget` (default 20, account currency); `setMetaMcpScopeTier()` for the tier upgrade. |
| `meta-mcp/auth/route.ts` (edit) | `?tier=write|financial` re-connects at a higher scope (default read). |
| `GrowthConnections.tsx` (edit) | "লেখা-অনুমতি যোগ করুন" upgrade button on the connected card (read tier only). |
| registry / tool-groups / capability-classification (edit) | Register the 6 write tools (growth group + lifestyle pool); classify create/update = stage/high, catalog = stage/medium, activate = before_execute/high. |
| `__tests__/meta-ads-write-tools.test.ts` (NEW) | 9 tests: registration, triple gate (kill/conn/read-tier), budget cap (over/under), PAUSED staging, activate = separate 🔴 before_execute card, 24h learning warn. |

## Safety contract (why the code cannot spend on its own)

A single taka only moves if ALL of these happen: (1) owner re-connects at **write** tier, (2) the ad account is inside Meta's MCP rollout, (3) owner **Approves** the staged card, and for spend specifically (4) owner approves the **separate** 🔴 activate card. Reads/creates land PAUSED. Budget over the owner cap is refused before any card is even staged.

## Budget-unit note (honest)

Meta budget fields are in the account currency's MINOR unit (cents), the documented Graph convention the MCP wraps. The guardrail reads `daily_budget/lifetime_budget ÷ 100` — always-÷100 is safe (a large minor value stays large and is caught; a mistaken whole-unit value only reads smaller, never larger). **Re-confirm against a real MCP write response once Meta enables the account.**

## Verification

| Check | Result |
|---|---|
| type-check + build | **PASS** |
| `vitest run src/agent` | **PASS — 2213** (9 new MA3 tests) |
| `git diff --stat` scope | **PASS** — agent code + `/api/assistant/*` only; zero ERP files |
| Live end-to-end (create a real PAUSED campaign in Ads Manager) | **BLOCKED BY META** — see below |

## Live acceptance is Meta-rollout-blocked

The plan's §6 acceptance ("campaign exists in Ads Manager **paused**") cannot be exercised today: Meta's MCP write tools reject the owner's ad accounts with `is_ads_mcp_enabled: false` ("Ads MCP is gradually being rolled out"), the SAME wall as MA2 insights. So MA3 ships code-complete + unit-proven, and its live proof waits on:
1. Meta enabling `is_ads_mcp_enabled` for the account (out of our control).
2. Owner re-connecting at write tier (button shipped).
3. Facebook app: production callback + App Domains for `alma-erp-six.vercel.app` (only preview added so far).

When those land, the flow is: chat "নতুন ক্যাম্পেইন বানাও" → staged PAUSED card → Approve → campaign in Ads Manager (paused) → separate 🔴 activate card to start spend. No further code needed on the happy path.

## Not in MA3 (correctly deferred)

MA4 = cutover/cleanup/observability (retire duplicate Graph reads, MCP health panel, ntfy on auth expiry, docs). The state-router `ads` domain pack was intentionally left unchanged (MA1 read tools also route via the growth group only).
