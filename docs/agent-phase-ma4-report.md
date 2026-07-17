# Phase MA4 Report — cutover, cleanup, observability

**Branch:** `agent-phase-ma4` (tag `pre-agent-phase-ma4` = main @ 1b3bd021, i.e. MA1+MA2+MA3 merged) · **Date:** 2026-07-17
**Plan:** `docs/META_ADS_MCP_INTEGRATION_PLAN.md` §7 — final phase.

## What shipped (works today)

| File | What |
|---|---|
| `src/agent/lib/meta-mcp/health.ts` (NEW) | `getMetaMcpHealth()` — aggregates `AgentToolEvent` (meta_ads_* reads + meta_ads:* writes) into 24h/7d call counts, success rate, error breakdown, last success/failure. `maybeAlertMetaMcpAuthExpiry()` — throttled (≤1/6h) owner ntfy "আবার Connect চাপুন" on terminal auth failure. Fail-open. |
| `bridge.ts` (edit) | On a terminal `auth` MetaMcpError (connected account, token expired — NOT never-connected) fires the throttled auth-expiry ntfy. |
| `meta-mcp/status/route.ts` (edit) | Status now returns `health` (call counts / success rate / last success / last error). |
| `GrowthConnections.tsx` (edit) | Connected card shows the MCP health line (৭ দিনে N কল · সফল X% · শেষ সফল … · শেষ এরর …). |
| `docs/ROUTER_WORKER_ARCHITECTURE.md` (edit) | New appendix documenting the whole meta-mcp module (MA1–MA4) + what stays on Graph. |
| `__tests__/health.test.ts` (NEW) | 6 tests: meta-only counting, 24h/7d split, success rate, last success/error, fail-open, alert throttle. |

## Cutover decision (honest — no risky churn)

Plan §7 asks to "migrate insight/catalog reads to MCP where equivalent." That
migration is **already done for insights** by MA2's `insights-source.ts`
(MCP-preferred, Graph fallback) — the single entry point the marketing brain
uses. The remaining direct Graph callers (owner-briefing, capability-audit,
audiences, CAPI, ad-library, Messenger, boost, page posting) are **deliberately
left on Graph**:

1. **Meta's MCP is per-account rollout-gated** (`is_ads_mcp_enabled: false`
   today) — routing more reads through MCP would just fall back to Graph anyway,
   so there is **no live benefit** to churning them now.
2. Broadly rewriting working money/marketing call-sites at this stage is exactly
   the "no whack-a-mole" risk the owner flagged — churn with regression risk and
   zero user-visible gain while gated.

So MA4 ships the parts that **work and add value today** (observability +
auth-expiry alert + docs) and records the read-cutover of the rest as
**deferred until Meta enables the account**, at which point each call-site can
move to `insights-source.ts` behind the same fallback with a live before/after.

## fb-token-health scope

**Unchanged.** §7 anticipated shrinking it "to what Graph API still serves" —
but with MCP gated, Graph still serves EVERY ads path (reads via fallback,
writes, audiences, CAPI, posting). Nothing to shrink yet; revisit after Meta
enables the account and MCP reads/writes prove out live. Documented in the arch
appendix.

## Verification

| Check | Result |
|---|---|
| type-check + build | **PASS** |
| `vitest run src/agent` | **PASS — 2225** (6 new MA4 tests) |
| `git diff --stat` scope | **PASS** — agent code + docs only; zero ERP files |
| Disconnect → clear degradation, nothing crashes | **PASS** — read tools + insights-source already return honest degradedReason; health is fail-open |
| Live MCP call metrics populated | **PENDING META** — counts populate once MCP calls actually run (rollout-gated today); the panel shows "0 কল" honestly until then |

## The whole Meta Ads MCP program (MA1–MA4)

- **MA1** connect + 23 read tools — merged (#452).
- **MA2** MCP-preferred insights with structural source honesty — merged (#452).
- **MA3** write tools behind approval cards + 🔴 activate + budget guard — merged (#453).
- **MA4** observability + auth-expiry alert + cutover decision + docs — this branch.

**One external blocker across the board:** Meta's per-account MCP rollout
(`is_ads_mcp_enabled`). Every insight/write live-proof waits on it; all the code
degrades to Graph honestly until then, and the 7 owner-caught ad-insight truth
bugs (fixed in the MA1+MA2 merge) work regardless.
