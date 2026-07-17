/**
 * Meta Ads campaign insights — mirrors worker/src/ads/monitor.mjs fetch logic.
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

function adsToken(): string {
  const tok = process.env.META_ADS_TOKEN
  if (!tok) throw new Error('META_ADS_TOKEN সেট করা নেই')
  return tok
}

function adAccountId(): string {
  const id = process.env.META_AD_ACCOUNT_ID
  if (!id) throw new Error('META_AD_ACCOUNT_ID সেট করা নেই')
  return id
}

function safeNum(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

function purchaseValueFromActions(actions: Array<{ action_type?: string; value?: string }> | undefined): number {
  return (actions ?? [])
    .filter((a) => a.action_type === 'purchase')
    .reduce((s, a) => s + safeNum(a.value), 0)
}

async function adsApi<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`)
  url.searchParams.set('access_token', adsToken())
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const res = await resilientFetch(url.toString(), { timeoutMs: 30_000, retries: 1 })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Ads API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export type CampaignMetrics = {
  campaignId: string
  name: string
  spendToday: number
  spendWeek: number
  impressionsToday: number
  impressionsWeek: number
  clicksToday: number
  clicksWeek: number
  /** CTR as a PERCENT, exactly as Meta reports it (4.79 = 4.79%) — never a 0–1 ratio.
   *  The old names invited a `* 100` at every call site and printed 479% for a
   *  real 4.79% week (live-hit 2026-07-17). */
  ctrTodayPct: number
  ctrWeekPct: number
  cpcToday: number
  roasToday: number
  roasWeek: number
  dailyBudgetBdt: number
  effectiveStatus: string
  hasEnoughData: boolean
  /** Ad-account billing currency (e.g. USD) — every spend/budget number above is in THIS currency. */
  currency: string
  /** Campaign objective (e.g. OUTCOME_ENGAGEMENT / MESSAGES / OUTCOME_SALES) — judge performance by THIS, not always purchases. */
  objective: string
}

export const INSIGHT_MIN_SPEND_BDT = 500
export const INSIGHT_MIN_IMPRESSIONS = 1000

/**
 * Spend is in the AD ACCOUNT'S currency — comparing a USD spend against the
 * ৳500 threshold marked real campaigns "thin" ($11.48 ≈ ৳1400 failed a check
 * it should pass; live-hit 2026-07-17). Rough fixed bands, no FX service.
 */
export function minSpendForCurrency(currency: string): number {
  if (currency === 'BDT') return INSIGHT_MIN_SPEND_BDT
  return 5 // USD/EUR-class: ~৳500-600
}

/**
 * Round an ad-spend amount in ITS OWN currency. Taka is whole-unit (ERP money
 * law, roundMoney); dollar-class currencies keep cents — rounding $11.48 to a
 * whole number reported "12" for a real $11.48 week (live-hit 2026-07-17).
 * Never apply roundMoney() to a non-BDT ad amount.
 */
export function roundAdSpend(amount: number, currency: string): number {
  if (currency === 'BDT') return Math.round(amount)
  return Math.round(amount * 100) / 100
}

/** Owner-facing money label in the ad account's real currency — never a bare ৳. */
export function formatAdSpend(amount: number, currency: string): string {
  if (currency === 'BDT') return `৳${Math.round(amount).toLocaleString('en-US')}`
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `
  return `${symbol}${(Math.round(amount * 100) / 100).toFixed(2)}`
}

export async function fetchActiveCampaignMetrics(): Promise<CampaignMetrics[]> {
  const accountId = adAccountId()
  // Fetch effective_status as a real field and filter to ACTIVE client-side.
  // The server-side `effective_status` filter param proved unreliable (it let
  // PAUSED campaigns through), so we never trust it: we read the actual status
  // and decide here. This also lets us surface the true status to the agent so
  // it can never mislabel a live campaign as paused.
  const campaignsRes = await adsApi<{
    data?: Array<{ id: string; name: string; daily_budget?: string; effective_status?: string; objective?: string }>
  }>(
    `${accountId}/campaigns`,
    { fields: 'id,name,daily_budget,effective_status,objective', limit: '100' },
  )

  const activeCampaigns = (campaignsRes.data ?? []).filter(
    (c) => c.effective_status === 'ACTIVE',
  )
  if (!activeCampaigns.length) return []

  // Meta returns `spend` in the AD ACCOUNT'S OWN currency. This account bills in
  // USD, but the tool used to hardcode ৳ — the owner saw "৳947" where Ads
  // Manager showed dollars. Fetch the real currency once and label every number.
  let accountCurrency = 'USD'
  try {
    const acct = await adsApi<{ currency?: string }>(accountId, { fields: 'currency' })
    if (acct.currency) accountCurrency = acct.currency
  } catch {
    /* keep default */
  }

  const today = new Date().toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const rows: CampaignMetrics[] = []

  for (const campaign of activeCampaigns) {
    try {
      const todayData = await adsApi<{ data?: Array<Record<string, unknown>> }>(
        `${campaign.id}/insights`,
        {
          time_range: JSON.stringify({ since: today, until: today }),
          fields: 'spend,impressions,clicks,ctr,cpc,actions',
        },
      )
      const weekData = await adsApi<{ data?: Array<Record<string, unknown>> }>(
        `${campaign.id}/insights`,
        {
          time_range: JSON.stringify({ since: sevenDaysAgo, until: today }),
          fields: 'spend,impressions,clicks,ctr,cpc,actions',
        },
      )

      const todayInsight = todayData.data?.[0] ?? {}
      const weekInsight = weekData.data?.[0] ?? {}

      const spendToday = safeNum(todayInsight.spend)
      const spendWeek = safeNum(weekInsight.spend)
      const impressionsToday = safeNum(todayInsight.impressions)
      const impressionsWeek = safeNum(weekInsight.impressions)
      const clicksToday = safeNum(todayInsight.clicks)
      const clicksWeek = safeNum(weekInsight.clicks)
      const ctrTodayPct = safeNum(todayInsight.ctr)
      const ctrWeekPct = safeNum(weekInsight.ctr)
      const cpcToday = safeNum(todayInsight.cpc)

      const roasToday = spendToday > 0
        ? purchaseValueFromActions(todayInsight.actions as Array<{ action_type?: string; value?: string }>) / spendToday
        : 0
      const roasWeek = spendWeek > 0
        ? purchaseValueFromActions(weekInsight.actions as Array<{ action_type?: string; value?: string }>) / spendWeek
        : 0

      // Budget often lives at AD SET level ("Using ad set budget" in Ads
      // Manager) — the campaign field is then empty and we wrongly reported
      // "no daily budget". Fall back to summing the active ad sets' budgets.
      let dailyBudgetBdt = campaign.daily_budget
        ? Math.round(safeNum(campaign.daily_budget) / 100)
        : 0
      if (dailyBudgetBdt === 0) {
        try {
          const adsets = await adsApi<{ data?: Array<{ daily_budget?: string; effective_status?: string }> }>(
            `${campaign.id}/adsets`,
            { fields: 'daily_budget,effective_status', limit: '25' },
          )
          dailyBudgetBdt = Math.round(
            (adsets.data ?? [])
              .filter((a) => a.effective_status === 'ACTIVE')
              .reduce((sum, a) => sum + safeNum(a.daily_budget), 0) / 100,
          )
        } catch { /* keep 0 */ }
      }

      rows.push({
        currency: accountCurrency,
        objective: campaign.objective ?? 'UNKNOWN',
        campaignId: campaign.id,
        name: campaign.name,
        spendToday,
        spendWeek,
        impressionsToday,
        impressionsWeek,
        clicksToday,
        clicksWeek,
        ctrTodayPct,
        ctrWeekPct,
        cpcToday,
        roasToday,
        roasWeek,
        dailyBudgetBdt,
        effectiveStatus: campaign.effective_status ?? 'ACTIVE',
        hasEnoughData: spendWeek >= minSpendForCurrency(accountCurrency) && impressionsWeek >= INSIGHT_MIN_IMPRESSIONS,
      })
    } catch (err) {
      console.warn(`[ads-insights] ${campaign.name} failed:`, err instanceof Error ? err.message : err)
    }
  }

  return rows
}

export type CampaignMetricsWindow = {
  /** The env-configured ad account actually read — surfaced so a misconfigured
   *  META_AD_ACCOUNT_ID shows up as "wrong account", never as a silent ৳0. */
  accountId: string
  currency: string
  windowDays: number
  campaigns: CampaignMetrics[]
}

/**
 * Window-based campaign metrics — STATUS-AGNOSTIC (live-found bug 2026-07-17):
 * fetchActiveCampaignMetrics() filters to currently-ACTIVE campaigns, so a
 * campaign the owner paused TODAY vanished from "last 7 days performance" and
 * the agent reported spend ৳0 while Ads Manager showed $11.48. Historical
 * reads (reports, digests, measurement health) must include every campaign
 * that DELIVERED in the window regardless of its status right now.
 *
 * Uses account-level insights (level=campaign + time_range) — one call returns
 * all campaigns with delivery in the window, paused or not (verified live
 * against act_…468: returns the paused campaign's real $11.48). Optimizer and
 * other "what should I touch NOW" paths stay on fetchActiveCampaignMetrics.
 */
export async function fetchCampaignMetricsWindow(windowDays = 7): Promise<CampaignMetricsWindow> {
  const accountId = adAccountId()
  const today = new Date().toISOString().slice(0, 10)
  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10)

  type InsightRow = Record<string, unknown> & { campaign_id?: string; campaign_name?: string }
  const insightParams = (since: string, until: string) => ({
    level: 'campaign',
    time_range: JSON.stringify({ since, until }),
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions',
    limit: '100',
  })

  const [windowRes, todayRes, campaignsRes, acctRes] = await Promise.all([
    adsApi<{ data?: InsightRow[] }>(`${accountId}/insights`, insightParams(windowStart, today)),
    adsApi<{ data?: InsightRow[] }>(`${accountId}/insights`, insightParams(today, today)).catch(() => ({ data: [] as InsightRow[] })),
    adsApi<{ data?: Array<{ id: string; name?: string; daily_budget?: string; effective_status?: string; objective?: string }> }>(
      `${accountId}/campaigns`,
      { fields: 'id,name,daily_budget,effective_status,objective', limit: '100' },
    ).catch(() => ({ data: [] as Array<{ id: string; name?: string; daily_budget?: string; effective_status?: string; objective?: string }> })),
    adsApi<{ currency?: string }>(accountId, { fields: 'currency' }).catch(() => ({ currency: undefined })),
  ])

  const currency = acctRes.currency ?? 'USD'
  const metaById = new Map((campaignsRes.data ?? []).map((c) => [c.id, c]))
  const todayById = new Map((todayRes.data ?? []).filter((r) => r.campaign_id).map((r) => [r.campaign_id as string, r]))

  const campaigns: CampaignMetrics[] = []
  for (const row of windowRes.data ?? []) {
    const id = String(row.campaign_id ?? '')
    if (!id) continue
    const meta = metaById.get(id)
    const todayRow = todayById.get(id) ?? {}

    const spendWeek = safeNum(row.spend)
    const spendToday = safeNum(todayRow.spend)

    let dailyBudgetBdt = meta?.daily_budget ? Math.round(safeNum(meta.daily_budget) / 100) : 0
    if (dailyBudgetBdt === 0) {
      try {
        const adsets = await adsApi<{ data?: Array<{ daily_budget?: string; effective_status?: string }> }>(
          `${id}/adsets`,
          { fields: 'daily_budget,effective_status', limit: '25' },
        )
        dailyBudgetBdt = Math.round(
          (adsets.data ?? []).reduce((sum, a) => sum + safeNum(a.daily_budget), 0) / 100,
        )
      } catch { /* keep 0 */ }
    }

    campaigns.push({
      currency,
      objective: meta?.objective ?? 'UNKNOWN',
      campaignId: id,
      name: String(row.campaign_name ?? meta?.name ?? id),
      spendToday,
      spendWeek,
      impressionsToday: safeNum(todayRow.impressions),
      impressionsWeek: safeNum(row.impressions),
      clicksToday: safeNum(todayRow.clicks),
      clicksWeek: safeNum(row.clicks),
      ctrTodayPct: safeNum(todayRow.ctr),
      ctrWeekPct: safeNum(row.ctr),
      cpcToday: safeNum(todayRow.cpc),
      roasToday: spendToday > 0
        ? purchaseValueFromActions(todayRow.actions as Array<{ action_type?: string; value?: string }>) / spendToday
        : 0,
      roasWeek: spendWeek > 0
        ? purchaseValueFromActions(row.actions as Array<{ action_type?: string; value?: string }>) / spendWeek
        : 0,
      dailyBudgetBdt,
      // The TRUE current status (may be PAUSED) — historical rows must never be
      // presented as currently running.
      effectiveStatus: meta?.effective_status ?? 'UNKNOWN',
      hasEnoughData: spendWeek >= minSpendForCurrency(currency) && safeNum(row.impressions) >= INSIGHT_MIN_IMPRESSIONS,
    })
  }

  return { accountId, currency, windowDays, campaigns }
}

export async function fetchCampaignDailyBudgetBdt(campaignId: string): Promise<number> {
  const data = await adsApi<{ daily_budget?: string }>(
    campaignId,
    { fields: 'daily_budget' },
  )
  return data.daily_budget ? Math.round(safeNum(data.daily_budget) / 100) : 0
}
