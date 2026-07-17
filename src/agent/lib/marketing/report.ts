/**
 * Weekly / on-demand marketing funnel report — paid + Messenger + COD.
 * Directional attribution; honest about thin data.
 */
import { prisma } from '@/lib/prisma'
import { agentSmartText } from '@/agent/lib/llm-text'
import { roundAdSpend } from '@/agent/lib/ads/insights'
import { readAdInsights, type AdInsightsRead } from '@/agent/lib/meta-mcp/insights-source'
import { getTopCreativeAngles } from '@/agent/lib/ads/creative-performance'
import { getCsAnalyticsSummary } from '@/agent/lib/cs/analytics'
import { buildMarketingIntel } from '@/lib/content-intelligence'
import { getAgentOrdersSummary } from '@/lib/agent-api/orders.service'
import { roundMoney } from '@/lib/money'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Race a promise against a deadline and fall back instead of hanging. The weekly
 * report is pulled by the VPS scheduler over HTTP; a slow Meta/insights call used
 * to block the whole report past the caller's timeout ("operation aborted due to
 * timeout"). Each external source now degrades to thin-data on its own budget.
 */
const EMPTY_CS_SUMMARY: Awaited<ReturnType<typeof getCsAnalyticsSummary>> = {
  conversations: 0, agentReplies: 0, commentCaptures: 0, draftsCreated: 0, draftsConfirmed: 0,
  conversionChatToDraft: 0, conversionDraftToConfirmed: 0, followupsSent: 0, followupsExpired: 0,
  followupRecoveries: 0, topAskedProducts: [], lostSaleReasons: {}, csCostUsd: 0,
}

/** Honest empty read — carries provenance even when nothing could be fetched. */
const EMPTY_PAID_READ: AdInsightsRead = {
  source: 'graph_api',
  sourceLabel: 'Meta Graph API (পুরনো পথ) থেকে',
  degradedReason: 'অ্যাড ডেটা পড়া যায়নি',
  accountId: process.env.META_AD_ACCOUNT_ID ?? '',
  currency: 'USD',
  windowDays: 7,
  campaigns: [],
  totalSpend: 0,
  totalSpendLabel: '$0.00',
  mcp: null,
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[marketing-report] ${label} exceeded ${ms}ms — using fallback`)
      resolve(fallback)
    }, ms)
  })
  return Promise.race([p.finally(() => clearTimeout(timer)), guard])
}

export type MarketingReportData = {
  periodDays: number
  generatedAt: string
  paid: {
    totalSpendWeek: number
    /** Ad-account billing currency — totalSpendWeek/spendWeek are in THIS, not ৳ (live-hit 2026-07-17). */
    currency: string
    /** The ad account actually read (env META_AD_ACCOUNT_ID) — surfaces misconfig instead of silent 0. */
    accountId: string | null
    campaigns: Array<{
      name: string
      spendWeek: number
      roasWeek: number
      ctrWeekPct: number
      hasData: boolean
      effectiveStatus: string
      /** Performance detail — without these the head cannot answer "ad performance" at all. */
      impressionsWeek: number
      clicksWeek: number
    }>
    bestCampaign: string | null
    worstCampaign: string | null
    topAngles: Array<{ angle: string; avgRoas: number; count: number }>
    thinData: boolean
    /**
     * MA2 — where these numbers actually came from, and Meta's own intelligence
     * when its MCP is open for this account. `source` is never a guess: the head
     * must quote sourceLabel and may only say "Meta MCP" when source is meta_mcp.
     */
    source: 'meta_mcp' | 'graph_api'
    sourceLabel: string
    degradedReason: string | null
    metaIntelligence: {
      trend: unknown | null
      anomaly: unknown | null
      opportunityScore: unknown | null
      industryBenchmark: unknown | null
      auctionBenchmarks: unknown | null
    } | null
  }
  funnel: {
    cs: Awaited<ReturnType<typeof getCsAnalyticsSummary>>
    ordersWeek: { totalOrders: number; totalRevenue: number; deliveredCount: number | null }
    thinData: boolean
  }
  organic: {
    staleProducts: number
    upcomingSeasons: number
    recentStaffTasks: Array<{ title: string; type: string; status: string }>
  }
}

export async function gatherMarketingReportData(days = 7): Promise<MarketingReportData> {
  const [
    paidWindow,
    topAngles,
    cs,
    ordersWeek,
    marketingIntel,
    staffTasks,
  ] = await Promise.all([
    withTimeout(
      // MA2: MCP-preferred, Graph-fallback — the read reports its own true source.
      // Status-agnostic window (live-found 2026-07-17): a campaign paused TODAY
      // must still appear in "last N days"; the ACTIVE-only path made the agent
      // report ৳0 while Ads Manager showed real spend.
      readAdInsights(days).catch((err): AdInsightsRead => {
        console.warn('[marketing-report] campaign metrics fetch failed:', err instanceof Error ? err.message : String(err))
        return { ...EMPTY_PAID_READ, degradedReason: 'অ্যাড ডেটা আনা যায়নি' }
      }),
      25_000,
      EMPTY_PAID_READ,
      'campaign metrics',
    ),
    withTimeout(getTopCreativeAngles(5).catch(() => []), 8_000, [], 'creative angles'),
    withTimeout(getCsAnalyticsSummary(days), 12_000, EMPTY_CS_SUMMARY, 'cs analytics'),
    withTimeout(
      getAgentOrdersSummary('week').catch((err) => {
        console.warn('[marketing-report] orders summary fetch failed:', err instanceof Error ? err.message : String(err))
        return null
      }),
      12_000, null, 'orders summary',
    ),
    withTimeout(
      buildMarketingIntel().catch((err) => {
        console.warn('[marketing-report] marketing intel failed:', err instanceof Error ? err.message : String(err))
        return null
      }),
      12_000, null, 'marketing intel',
    ),
    db.agentStaffTask.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - days * 86400000) },
        type: { in: ['organic_marketing', 'offer_idea', 'ad_creative', 'product_content'] },
        businessId: 'ALMA_LIFESTYLE',
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { title: true, type: true, status: true },
    }).catch((err: unknown) => {
      console.warn('[marketing-report] staff tasks query failed:', err instanceof Error ? err.message : String(err))
      return []
    }),
  ])

  const campaigns = paidWindow.campaigns
  const withData = campaigns.filter((c) => c.hasEnoughData)
  const totalSpendWeek = campaigns.reduce((s, c) => s + c.spendWeek, 0)
  const sorted = [...withData].sort((a, b) => b.roasWeek - a.roasWeek)

  let deliveredCount: number | null = null
  if (ordersWeek?.byStatus) {
    deliveredCount = ordersWeek.byStatus.delivered ?? ordersWeek.byStatus.Delivered ?? null
  }

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    paid: {
      // Currency-aware: Math.round() on a USD amount reported "12" for a real
      // $11.48 week (live-hit 2026-07-17). Taka stays whole per ERP money law.
      totalSpendWeek: roundAdSpend(totalSpendWeek, paidWindow.currency),
      currency: paidWindow.currency,
      accountId: paidWindow.accountId || null,
      campaigns: campaigns.map((m) => ({
        name: m.name,
        spendWeek: roundAdSpend(m.spendWeek, paidWindow.currency),
        roasWeek: Number(m.roasWeek.toFixed(2)),
        ctrWeekPct: Number(m.ctrWeekPct.toFixed(2)),
        hasData: m.hasEnoughData,
        effectiveStatus: m.effectiveStatus,
        impressionsWeek: m.impressionsWeek,
        clicksWeek: m.clicksWeek,
      })),
      bestCampaign: sorted[0]?.name ?? null,
      worstCampaign: sorted.length > 1 ? sorted[sorted.length - 1]?.name ?? null : null,
      topAngles,
      thinData: withData.length === 0,
      source: paidWindow.source,
      sourceLabel: paidWindow.sourceLabel,
      degradedReason: paidWindow.degradedReason,
      metaIntelligence: paidWindow.mcp,
    },
    funnel: {
      cs,
      ordersWeek: {
        totalOrders: ordersWeek?.totalOrders ?? 0,
        totalRevenue: ordersWeek ? roundMoney(ordersWeek.totalRevenue) : 0,
        deliveredCount,
      },
      thinData: cs.conversations < 3 && (ordersWeek?.totalOrders ?? 0) < 5,
    },
    organic: {
      staleProducts: marketingIntel?.staleProducts?.length ?? 0,
      upcomingSeasons: marketingIntel?.upcomingSeasons?.length ?? 0,
      recentStaffTasks: staffTasks as Array<{ title: string; type: string; status: string }>,
    },
  }
}

const REPORT_SYSTEM = `আপনি ALMA Lifestyle marketing analyst। Owner-কে Bangla weekly funnel report লিখুন।

STRUCTURE (markdown):
## 📊 Paid (Meta)
- spend, ROAS trend, best/worst campaign, best creative angle (if data)
## 🚨 Meta-র নিজস্ব সংকেত (anomaly / benchmark)
- paid.metaIntelligence থাকলে: anomaly + industry/auction benchmark + opportunity score-এর মানে এক-দুই লাইনে
  (যেমন "CTR ইন্ডাস্ট্রি গড়ের নিচে")। null হলে এক লাইনে সৎভাবে paid.degradedReason লিখুন — বানাবেন না।
## 🔗 Funnel (ad → Messenger → COD)
- chat count, draft→confirm rates, orders, where it leaks — directional only
## 📱 Organic
- what was posted / staff tasks if known
## ✅ এই সপ্তাহের ২–৩ concrete moves
- numbered, high-leverage, feeds next marketing plan

RULES:
- Cite real numbers from data only — invent নয়।
- Thin data হলে স্পষ্ট বলুন।
- correlation ≠ causation; Meta ROAS ≠ exact COD profit।
- Max 3 recommendations — noisy report নিষিদ্ধ।
- MONEY: paid.currency দেখুন — spend ওই মুদ্রায় (BDT না হলে ৳ লিখবেন না, $ /  আসল চিহ্ন ব্যবহার করুন)।
- SOURCE: paid.sourceLabel হুবহু কোট করুন। paid.source === "meta_mcp" না হলে "Meta MCP থেকে" কখনো লিখবেন না।
- STATUS: campaigns[].effectiveStatus PAUSED হলে ওটা বন্ধ ক্যাম্পেইনের ইতিহাস — সংখ্যা আসল, কিন্তু "চলছে" বলবেন না।`

export async function buildMarketingReportText(days = 7): Promise<{
  report: string
  data: MarketingReportData
  recommendations: string[]
}> {
  const data = await gatherMarketingReportData(days)

  // Phase 42: report against the approved Growth Brief targets when one exists
  // (read-only — a missing brief never blocks the report).
  let briefLine = ''
  try {
    const { getApprovedBrief } = await import('@/agent/lib/marketing/growth-brief')
    const brief = await getApprovedBrief('ALMA_LIFESTYLE')
    if (brief) {
      const b = brief.brief
      briefLine =
        `\nApproved Growth Brief v${brief.version}: objective="${b.objective ?? ''}", ` +
        `monthlyBudgetCapBdt=${b.economics?.monthlyBudgetCapBdt ?? 'n/a'}, targetCpaBdt=${b.economics?.targetCpaBdt ?? 'n/a'} — ` +
        'judge the numbers against these targets.\n'
    }
  } catch {
    /* report works without the brief */
  }

  let report: string
  try {
    // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now).
    const raw = await agentSmartText({
      system: REPORT_SYSTEM,
      prompt: `Weekly marketing report (${days} days). Today: ${todayYmdDhaka()}\n${briefLine}\nData:\n${JSON.stringify(data, null, 0).slice(0, 14000)}`,
      maxTokens: 2000,
      costLabel: 'marketing_report',
    })
    report = raw || formatMarketingReportFallback(data)
  } catch (err) {
    // A slow/failed LLM must not blow the caller's timeout — ship the deterministic report.
    console.warn('[marketing-report] LLM call failed/timed out — using fallback:', err instanceof Error ? err.message : String(err))
    return { report: formatMarketingReportFallback(data), data, recommendations: [] }
  }

  const recMatch = report.match(/## ✅[^\n]*\n([\s\S]*?)(?=## |$)/)
  const recommendations = recMatch
    ? recMatch[1].split('\n').filter((l) => /^\d+\./.test(l.trim())).slice(0, 3)
    : []

  return { report, data, recommendations }
}

export function formatMarketingReportFallback(data: MarketingReportData): string {
  const L = [
    `📈 *Marketing Report — ${data.periodDays} দিন*`,
    '',
    '*Paid (Meta)*',
    data.paid.thinData
      ? '• ডেটা পাতলা — active campaign insights নেই বা spend কম।'
      : `• Spend ~${data.paid.currency === 'BDT' ? '৳' : `${data.paid.currency} `}${data.paid.totalSpendWeek} | Best: ${data.paid.bestCampaign ?? '—'} | Worst: ${data.paid.worstCampaign ?? '—'}`,
    data.paid.topAngles[0]
      ? `• Top angle: "${data.paid.topAngles[0].angle}" (avg ROAS ${data.paid.topAngles[0].avgRoas.toFixed(1)}x)`
      : '',
    '',
    '*Funnel (directional)*',
    `• Messenger chats: ${data.funnel.cs.conversations} | Draft→Confirm: ${data.funnel.cs.conversionDraftToConfirmed}%`,
    `• Orders (week): ${data.funnel.ordersWeek.totalOrders} | Revenue ~৳${data.funnel.ordersWeek.totalRevenue}`,
    data.funnel.thinData ? '• ⚠️ Funnel data thin — trends directional only.' : '',
    '',
    '*Organic*',
    `• Stale products (30d+): ${data.organic.staleProducts} | Upcoming seasons: ${data.organic.upcomingSeasons}`,
  ]
  if (data.organic.recentStaffTasks.length) {
    L.push('• Recent content tasks:')
    data.organic.recentStaffTasks.slice(0, 4).forEach((t) => {
      L.push(`  - [${t.type}] ${t.title} (${t.status})`)
    })
  }
  L.push('', '_Approve marketing plan items separately — nothing auto-executes._')
  return L.filter(Boolean).join('\n')
}
