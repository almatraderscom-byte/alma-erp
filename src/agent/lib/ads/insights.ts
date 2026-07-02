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
  ctrToday: number
  ctrWeek: number
  cpcToday: number
  roasToday: number
  roasWeek: number
  dailyBudgetBdt: number
  effectiveStatus: string
  hasEnoughData: boolean
  /** Ad-account billing currency (e.g. USD) — every spend/budget number above is in THIS currency. */
  currency: string
}

export const INSIGHT_MIN_SPEND_BDT = 500
export const INSIGHT_MIN_IMPRESSIONS = 1000

export async function fetchActiveCampaignMetrics(): Promise<CampaignMetrics[]> {
  const accountId = adAccountId()
  // Fetch effective_status as a real field and filter to ACTIVE client-side.
  // The server-side `effective_status` filter param proved unreliable (it let
  // PAUSED campaigns through), so we never trust it: we read the actual status
  // and decide here. This also lets us surface the true status to the agent so
  // it can never mislabel a live campaign as paused.
  const campaignsRes = await adsApi<{
    data?: Array<{ id: string; name: string; daily_budget?: string; effective_status?: string }>
  }>(
    `${accountId}/campaigns`,
    { fields: 'id,name,daily_budget,effective_status', limit: '100' },
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
      const ctrToday = safeNum(todayInsight.ctr)
      const ctrWeek = safeNum(weekInsight.ctr)
      const cpcToday = safeNum(todayInsight.cpc)

      const roasToday = spendToday > 0
        ? purchaseValueFromActions(todayInsight.actions as Array<{ action_type?: string; value?: string }>) / spendToday
        : 0
      const roasWeek = spendWeek > 0
        ? purchaseValueFromActions(weekInsight.actions as Array<{ action_type?: string; value?: string }>) / spendWeek
        : 0

      const dailyBudgetBdt = campaign.daily_budget
        ? Math.round(safeNum(campaign.daily_budget) / 100)
        : 0

      rows.push({
        currency: accountCurrency,
        campaignId: campaign.id,
        name: campaign.name,
        spendToday,
        spendWeek,
        impressionsToday,
        impressionsWeek,
        clicksToday,
        clicksWeek,
        ctrToday,
        ctrWeek,
        cpcToday,
        roasToday,
        roasWeek,
        dailyBudgetBdt,
        effectiveStatus: campaign.effective_status ?? 'ACTIVE',
        hasEnoughData: spendWeek >= INSIGHT_MIN_SPEND_BDT && impressionsWeek >= INSIGHT_MIN_IMPRESSIONS,
      })
    } catch (err) {
      console.warn(`[ads-insights] ${campaign.name} failed:`, err instanceof Error ? err.message : err)
    }
  }

  return rows
}

export async function fetchCampaignDailyBudgetBdt(campaignId: string): Promise<number> {
  const data = await adsApi<{ daily_budget?: string }>(
    campaignId,
    { fields: 'daily_budget' },
  )
  return data.daily_budget ? Math.round(safeNum(data.daily_budget) / 100) : 0
}
