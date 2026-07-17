/**
 * Phase MA2 — ONE ad-insights source for the marketing brain.
 *
 * Plan §5: Meta's official MCP is the PREFERRED source; the existing Graph API
 * path stays as a graceful fallback whenever MCP is off, disconnected, or (the
 * live 2026-07-17 reality) the ad account is still outside Meta's gradual
 * `is_ads_mcp_enabled` rollout.
 *
 * WHY THIS MODULE EXISTS AT ALL (owner incident 2026-07-17): the head answered
 * an ads question from the Graph path while telling the owner "Meta MCP থেকে
 * লাইভ চেক করে দেখলাম". Prompt rules alone could not stop that. So source
 * attribution is STRUCTURAL here: every read returns the source it actually
 * used plus a ready-to-quote Bangla label, and the claim-verifier's
 * meta_mcp_source_claim rule enforces the rest. A caller cannot obtain data
 * without also obtaining its true provenance.
 *
 * Money: every amount is in the AD ACCOUNT'S currency (never assume ৳) — see
 * ads/insights.ts roundAdSpend/formatAdSpend.
 */
import {
  fetchCampaignMetricsWindow,
  formatAdSpend,
  type CampaignMetrics,
} from '@/agent/lib/ads/insights'
import { metaMcpCallTool } from './client'
import { bridgedToolName } from './bridge'
import { getMetaMcpConnection, isMetaMcpEnabled } from './oauth'

export type InsightsSource = 'meta_mcp' | 'graph_api'

export interface AdInsightsRead {
  /** The source that ACTUALLY produced `campaigns` — never a guess. */
  source: InsightsSource
  /** Ready-to-quote Bangla provenance line. Quote verbatim; never re-attribute. */
  sourceLabel: string
  /** Why MCP was not used (null when it was). Owner-facing Bangla. */
  degradedReason: string | null
  accountId: string
  currency: string
  windowDays: number
  campaigns: CampaignMetrics[]
  totalSpend: number
  totalSpendLabel: string
  /** MCP-only extras — null whenever the source is graph_api. */
  mcp: {
    trend: unknown | null
    anomaly: unknown | null
    opportunityScore: unknown | null
    industryBenchmark: unknown | null
    auctionBenchmarks: unknown | null
  } | null
}

const GRAPH_LABEL = 'Meta Graph API (পুরনো পথ) থেকে'
const MCP_LABEL = 'Meta-র অফিসিয়াল Ads MCP থেকে'

/** Numeric ad-account id (Meta MCP wants it bare; env may carry the act_ prefix). */
function bareAccountId(accountId: string): string {
  return accountId.replace(/^act_/, '')
}

function flattenMcpText(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }): {
  ok: boolean
  data: unknown
  text: string
} {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
  if (result.isError) return { ok: false, data: null, text }
  let data: unknown = result.structuredContent
  if (data === undefined) {
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
  }
  return { ok: true, data, text }
}

/**
 * Is this ad account inside Meta's MCP rollout? `ads_get_ad_accounts` carries
 * `is_ads_mcp_enabled` per account — the live 2026-07-17 answer for all three of
 * the owner's accounts was false ("Ads MCP is gradually being rolled out").
 * Returns the reason string when unavailable, null when good to go.
 */
async function mcpAccountBlockedReason(accountId: string): Promise<string | null> {
  try {
    const res = await metaMcpCallTool('ads_get_ad_accounts', {})
    const { ok, data, text } = flattenMcpText(res)
    if (!ok) return `Meta MCP অ্যাকাউন্ট তালিকা দেয়নি (${text.slice(0, 80)})`
    const list = (data as { ad_accounts?: Array<Record<string, unknown>> } | null)?.ad_accounts
    if (!Array.isArray(list)) return 'Meta MCP অ্যাকাউন্ট তালিকা পড়া যায়নি'
    const want = bareAccountId(accountId)
    const row = list.find((a) => String(a.ad_account_id ?? '') === want)
    if (!row) return `Meta MCP-তে এই ad account (${want}) নেই`
    if (row.is_ads_mcp_enabled !== true) {
      const why = typeof row.is_ads_mcp_disabled_reason === 'string' ? row.is_ads_mcp_disabled_reason : ''
      return `Meta এখনো এই ad account-এ MCP চালু করেনি (rollout বাকি)${why ? ` — ${why.slice(0, 100)}` : ''}`
    }
    return null
  } catch (e) {
    return `Meta MCP-তে পৌঁছানো যায়নি (${e instanceof Error ? e.message.slice(0, 80) : 'unknown'})`
  }
}

/** Best-effort MCP extra; never throws, never blocks the read. */
async function mcpExtra(tool: string, args: Record<string, unknown>): Promise<unknown | null> {
  try {
    const { ok, data } = flattenMcpText(await metaMcpCallTool(tool, args))
    return ok ? data : null
  } catch {
    return null
  }
}

/**
 * The marketing brain's single entry point for ad performance.
 * ALWAYS resolves (the Graph path is the floor) and ALWAYS reports its true
 * source. `preferMcp: false` forces the legacy path — the MA2 kill-switch test.
 */
export async function readAdInsights(
  windowDays = 7,
  opts?: { preferMcp?: boolean },
): Promise<AdInsightsRead> {
  // The Graph window read is the floor: it is the only source proven to work for
  // this account today, and MA2 must never regress it (plan §5 acceptance).
  const base = await fetchCampaignMetricsWindow(windowDays)
  const totalSpend = base.campaigns.reduce((s, c) => s + c.spendWeek, 0)
  const graphRead: AdInsightsRead = {
    source: 'graph_api',
    sourceLabel: GRAPH_LABEL,
    degradedReason: null,
    accountId: base.accountId,
    currency: base.currency,
    windowDays,
    campaigns: base.campaigns,
    totalSpend,
    totalSpendLabel: formatAdSpend(totalSpend, base.currency),
    mcp: null,
  }

  if (opts?.preferMcp === false) {
    return { ...graphRead, degradedReason: 'MCP ব্যবহার করা হয়নি (কল-সাইট চেয়েছে পুরনো পথ)' }
  }
  if (!(await isMetaMcpEnabled())) {
    return { ...graphRead, degradedReason: 'Meta Ads MCP বন্ধ (kill switch) — পুরনো Graph পথে পড়া হয়েছে' }
  }
  if (!(await getMetaMcpConnection())) {
    return { ...graphRead, degradedReason: 'Meta Ads MCP connect করা নেই — /agent/growth পেজে Connect চাপুন' }
  }

  const blocked = await mcpAccountBlockedReason(base.accountId)
  if (blocked) return { ...graphRead, degradedReason: blocked }

  // MCP is genuinely usable for this account — enrich. Meta's insight tools take
  // the bare numeric id (verified against the live schema 2026-07-17).
  const id = bareAccountId(base.accountId)
  const [trend, anomaly, opportunityScore, industryBenchmark, auctionBenchmarks] = await Promise.all([
    mcpExtra('ads_insights_performance_trend', { ad_account_id: id }),
    mcpExtra('ads_insights_anomaly_signal', { ad_account_id: id }),
    mcpExtra('ads_get_opportunity_score', { ad_account_id: id }),
    mcpExtra('ads_insights_industry_benchmark', { ad_account_id: id }),
    mcpExtra('ads_insights_auction_ranking_benchmarks', { ad_account_id: id }),
  ])

  const anyExtra = [trend, anomaly, opportunityScore, industryBenchmark, auctionBenchmarks].some((x) => x !== null)
  if (!anyExtra) {
    return { ...graphRead, degradedReason: 'Meta MCP সাড়া দেয়নি — পুরনো Graph পথে পড়া হয়েছে' }
  }

  return {
    ...graphRead,
    // Campaign rows still come from Graph (MCP's trend tools answer in prose/
    // structured summaries, not per-campaign rows) — so the honest label says
    // BOTH sources, never "MCP only".
    source: 'meta_mcp',
    sourceLabel: `${MCP_LABEL} (ক্যাম্পেইন সংখ্যা Graph API থেকে)`,
    degradedReason: null,
    mcp: { trend, anomaly, opportunityScore, industryBenchmark, auctionBenchmarks },
  }
}

/**
 * The provenance block every ads answer must carry. Structural honesty: the
 * head quotes `sourceLabel`, and `mcpToolsUsed` tells the claim-verifier whether
 * an MCP claim is even permissible this turn.
 */
export function provenanceOf(read: AdInsightsRead): {
  source: InsightsSource
  sourceLabel: string
  degradedReason: string | null
  mcpToolsUsed: string[]
  rule: string
} {
  return {
    source: read.source,
    sourceLabel: read.sourceLabel,
    degradedReason: read.degradedReason,
    mcpToolsUsed:
      read.source === 'meta_mcp'
        ? [
            bridgedToolName('ads_insights_performance_trend'),
            bridgedToolName('ads_insights_anomaly_signal'),
            bridgedToolName('ads_get_opportunity_score'),
          ]
        : [],
    rule:
      read.source === 'meta_mcp'
        ? 'Quote sourceLabel verbatim. MCP extras are in `mcp` — cite them as Meta MCP; campaign rows are Graph API.'
        : 'These numbers are NOT from Meta MCP. Quote sourceLabel verbatim and, if the owner asked about MCP, state degradedReason honestly.',
  }
}
