/**
 * Meta Ads campaign insights — mirrors worker/src/ads/monitor.mjs fetch logic.
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { metaGraphBase } from '@/lib/meta-version'

const GRAPH_BASE = metaGraphBase()

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

/**
 * ADS-2 phase B — everything else in `actions`.
 *
 * Meta returns one `actions` array per row carrying every result the campaign
 * produced: messaging conversations started, link clicks, landing page views,
 * leads, post engagement, video views, purchases. Until now this file read ONE
 * of them (`purchase`) and dropped the rest on the floor — which is why Boss
 * could not ask the agent the most basic question about his own account
 * ("কত মেসেজ পাচ্ছি") even though the answer arrived with every single call.
 *
 * Meta's action_type names are versioned and verbose
 * (`onsite_conversion.messaging_conversation_started_7d`), so match on a stable
 * fragment rather than an exact string that a Graph version bump would break.
 */
export type AdResults = {
  messagingConversations: number
  linkClicks: number
  landingPageViews: number
  leads: number
  postEngagement: number
  videoViews: number
  purchases: number
  /** Every action_type Meta sent, verbatim — so a result we have no name for is
   *  still visible instead of silently discarded. */
  raw: Record<string, number>
}

const EMPTY_RESULTS: AdResults = {
  messagingConversations: 0,
  linkClicks: 0,
  landingPageViews: 0,
  leads: 0,
  postEngagement: 0,
  videoViews: 0,
  purchases: 0,
  raw: {},
}

export function resultsFromActions(
  actions: Array<{ action_type?: string; value?: string }> | undefined,
): AdResults {
  if (!actions?.length) return { ...EMPTY_RESULTS, raw: {} }
  const out: AdResults = { ...EMPTY_RESULTS, raw: {} }
  for (const a of actions) {
    const type = a.action_type ?? ''
    if (!type) continue
    const n = safeNum(a.value)
    out.raw[type] = (out.raw[type] ?? 0) + n

    if (type.includes('messaging_conversation_started')) out.messagingConversations += n
    else if (type === 'link_click') out.linkClicks += n
    else if (type.includes('landing_page_view')) out.landingPageViews += n
    else if (type.includes('lead')) out.leads += n
    else if (type === 'post_engagement') out.postEngagement += n
    else if (type === 'video_view') out.videoViews += n
    else if (type === 'purchase') out.purchases += n
  }
  return out
}

/**
 * What this campaign is FOR, and therefore what it should be judged on.
 *
 * The agent told Boss his engagement campaign was "money waste, ROAS 0.0" on
 * 2026-07-27. ROAS on an OUTCOME_ENGAGEMENT campaign is 0.0 by construction —
 * it was never buying purchases. Judging every campaign by purchases is how a
 * working messaging campaign gets recommended for the chop.
 */
export type PrimaryResult = {
  key: keyof Omit<AdResults, 'raw'>
  /** Bangla label for the owner-facing line. */
  label: string
  count: number
  /** Spend ÷ count, in the account currency. 0 when there are no results yet. */
  costPer: number
}

export function primaryResultFor(
  objective: string,
  results: AdResults,
  spend: number,
): PrimaryResult {
  const pick = (key: PrimaryResult['key'], label: string): PrimaryResult => {
    const count = results[key]
    return { key, label, count, costPer: count > 0 ? spend / count : 0 }
  }
  const o = (objective || '').toUpperCase()
  if (o.includes('MESSAGE')) return pick('messagingConversations', 'মেসেজ/কথোপকথন')
  if (o.includes('ENGAGEMENT')) {
    // An engagement campaign optimised for messages reports both; conversations
    // are the ones worth money, so they win when present.
    return results.messagingConversations > 0
      ? pick('messagingConversations', 'মেসেজ/কথোপকথন')
      : pick('postEngagement', 'এনগেজমেন্ট')
  }
  if (o.includes('LEAD')) return pick('leads', 'লিড')
  if (o.includes('TRAFFIC') || o.includes('LINK_CLICKS')) return pick('linkClicks', 'লিংক ক্লিক')
  if (o.includes('VIDEO')) return pick('videoViews', 'ভিডিও ভিউ')
  if (o.includes('SALES') || o.includes('CONVERSION')) return pick('purchases', 'পারচেজ')
  // Unknown objective: fall back to the first result type that carries real
  // business value, NOT the biggest number. Post engagements always out-count
  // conversations by an order of magnitude, so "whichever is largest" would
  // report 210 likes and bury the 14 people who actually messaged him.
  const ladder: Array<[PrimaryResult['key'], string]> = [
    ['messagingConversations', 'মেসেজ/কথোপকথন'],
    ['leads', 'লিড'],
    ['purchases', 'পারচেজ'],
    ['linkClicks', 'লিংক ক্লিক'],
    ['postEngagement', 'এনগেজমেন্ট'],
  ]
  const found = ladder.find(([key]) => results[key] > 0)
  return found ? pick(found[0], found[1]) : pick('purchases', 'পারচেজ')
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
  /** Ad sets under this campaign whose own effective_status is ACTIVE. */
  activeAdSets: number
  /** Ads under this campaign whose own effective_status is ACTIVE. */
  activeAds: number
  /**
   * Is this campaign actually RUNNING, in the sense Boss means when he counts
   * campaigns in Ads Manager?
   *
   * ADS-2, 2026-07-27: he said two campaigns were active; we reported four. Both
   * were "right" — we were counting campaign-level `effective_status === ACTIVE`,
   * which stays ACTIVE while every ad set and ad beneath it is paused. One of the
   * four had spent $0.00 with 0 impressions for seven days and was still being
   * counted as running. A campaign that cannot deliver is not running, so
   * `delivering` requires a live ad set AND a live ad underneath.
   *
   * `effectiveStatus` is kept as-is next to it: the campaign-level truth is still
   * the truth, it is just not the answer to "কয়টা চলছে".
   */
  delivering: boolean
  /** Everything Meta's `actions` array carried for the window — messages, link
   *  clicks, leads, engagement, video views, purchases. Read `raw` for anything
   *  without a named field. */
  resultsWeek: AdResults
  resultsToday: AdResults
  /** The ONE number this campaign should be judged on, chosen from its objective,
   *  with its cost. An engagement campaign is not a failed shop. */
  primaryWeek: PrimaryResult
  /** Average times ONE person saw this campaign in the window. The fatigue
   *  signal — never available before ADS-2, so fatigue was being guessed. */
  frequencyWeek: number
  /** Unique people reached in the window (impressions ÷ frequency). */
  reachWeek: number
}

/**
 * Live ad sets and ads per campaign, in TWO account-level calls regardless of
 * how many campaigns exist — the per-campaign loop this file already runs is
 * expensive enough. Never throws: a failed structure read degrades to "unknown",
 * and an unknown structure must not turn a running campaign into a stopped one.
 */
export type CampaignStructure = { activeAdSets: number; activeAds: number; known: boolean }

export async function fetchCampaignStructure(
  accountId: string,
): Promise<Map<string, CampaignStructure>> {
  const byCampaign = new Map<string, CampaignStructure>()
  const bump = (id: string | undefined, key: 'activeAdSets' | 'activeAds') => {
    if (!id) return
    const row = byCampaign.get(id) ?? { activeAdSets: 0, activeAds: 0, known: true }
    row[key] += 1
    byCampaign.set(id, row)
  }

  const [adsets, ads] = await Promise.all([
    adsApi<{ data?: Array<{ campaign_id?: string; effective_status?: string }> }>(
      `${accountId}/adsets`,
      { fields: 'campaign_id,effective_status', limit: '200' },
    ).catch(() => null),
    adsApi<{ data?: Array<{ campaign_id?: string; effective_status?: string }> }>(
      `${accountId}/ads`,
      { fields: 'campaign_id,effective_status', limit: '200' },
    ).catch(() => null),
  ])

  if (!adsets || !ads) return byCampaign // empty map = "unknown", see deliveringFrom()

  for (const a of adsets.data ?? []) {
    if (a.effective_status === 'ACTIVE') bump(a.campaign_id, 'activeAdSets')
  }
  for (const a of ads.data ?? []) {
    if (a.effective_status === 'ACTIVE') bump(a.campaign_id, 'activeAds')
  }
  return byCampaign
}

/**
 * Fail SAFE, not silent: with no structure data at all we fall back to the old
 * campaign-level answer rather than reporting every campaign as stopped. A wrong
 * "everything is off" would be read as an outage.
 */
export function deliveringFrom(
  structure: Map<string, CampaignStructure>,
  campaignId: string,
  campaignIsActive: boolean,
): { activeAdSets: number; activeAds: number; delivering: boolean } {
  if (structure.size === 0) {
    return { activeAdSets: 0, activeAds: 0, delivering: campaignIsActive }
  }
  const row = structure.get(campaignId) ?? { activeAdSets: 0, activeAds: 0, known: true }
  return {
    activeAdSets: row.activeAdSets,
    activeAds: row.activeAds,
    delivering: campaignIsActive && row.activeAdSets > 0 && row.activeAds > 0,
  }
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
  const structure = await fetchCampaignStructure(accountId)
  const rows: CampaignMetrics[] = []

  for (const campaign of activeCampaigns) {
    try {
      const todayData = await adsApi<{ data?: Array<Record<string, unknown>> }>(
        `${campaign.id}/insights`,
        {
          time_range: JSON.stringify({ since: today, until: today }),
          // ADS-2 phase C: frequency + reach. Creative fatigue is measured in
          // how many times the same person saw the ad; without frequency the
          // agent was substituting Meta's "Ad Relevance" label and calling it a
          // fatigue read, which it is not.
          fields: 'spend,impressions,clicks,ctr,cpc,actions,frequency,reach',
        },
      )
      const weekData = await adsApi<{ data?: Array<Record<string, unknown>> }>(
        `${campaign.id}/insights`,
        {
          time_range: JSON.stringify({ since: sevenDaysAgo, until: today }),
          // ADS-2 phase C: frequency + reach. Creative fatigue is measured in
          // how many times the same person saw the ad; without frequency the
          // agent was substituting Meta's "Ad Relevance" label and calling it a
          // fatigue read, which it is not.
          fields: 'spend,impressions,clicks,ctr,cpc,actions,frequency,reach',
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

      const resultsWeek = resultsFromActions(
        weekInsight.actions as Array<{ action_type?: string; value?: string }>,
      )
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
        resultsWeek,
        resultsToday: resultsFromActions(
          todayInsight.actions as Array<{ action_type?: string; value?: string }>,
        ),
        primaryWeek: primaryResultFor(campaign.objective ?? 'UNKNOWN', resultsWeek, spendWeek),
        frequencyWeek: safeNum(weekInsight.frequency),
        reachWeek: safeNum(weekInsight.reach),
        ...deliveringFrom(structure, campaign.id, (campaign.effective_status ?? 'ACTIVE') === 'ACTIVE'),
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
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,frequency,reach',
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
  const structure = await fetchCampaignStructure(accountId)
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
    const windowResults = resultsFromActions(
      row.actions as Array<{ action_type?: string; value?: string }>,
    )

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
      resultsWeek: windowResults,
      resultsToday: resultsFromActions(
        todayRow.actions as Array<{ action_type?: string; value?: string }>,
      ),
      primaryWeek: primaryResultFor(meta?.objective ?? 'UNKNOWN', windowResults, spendWeek),
      frequencyWeek: safeNum(row.frequency),
      reachWeek: safeNum(row.reach),
      ...deliveringFrom(structure, id, (meta?.effective_status ?? 'UNKNOWN') === 'ACTIVE'),
      hasEnoughData: spendWeek >= minSpendForCurrency(currency) && safeNum(row.impressions) >= INSIGHT_MIN_IMPRESSIONS,
    })
  }

  return { accountId, currency, windowDays, campaigns }
}

/**
 * ADS-2 phase C — the account's own spending limits.
 *
 * Boss asked "roj koto kharoch hocche ar amar limit er moddhe achi kina" on
 * 2026-07-27 and the honest answer was "I don't know your cap" — because
 * nothing in this repo had ever read `spend_cap`. Meta has always exposed it.
 *
 * Money values arrive in the account currency's MINOR unit (cents), the same
 * convention the write guard already documents, so everything here is ÷100.
 * `spend_cap` of 0 means NO cap set, which is different from a cap of zero.
 */
export type AccountLimits = {
  currency: string
  /** Lifetime spend cap on the account, or null when none is set. */
  spendCap: number | null
  /** Lifetime spend counted against that cap. */
  amountSpent: number
  /** Prepaid balance, for accounts that run on one. */
  balance: number
  /** spendCap − amountSpent, or null when uncapped. */
  remaining: number | null
}

export async function fetchAccountLimits(): Promise<AccountLimits> {
  const accountId = adAccountId()
  const raw = await adsApi<{
    currency?: string
    spend_cap?: string
    amount_spent?: string
    balance?: string
  }>(accountId, { fields: 'currency,spend_cap,amount_spent,balance' })

  const minor = (v: unknown) => safeNum(v) / 100
  const cap = safeNum(raw.spend_cap) > 0 ? minor(raw.spend_cap) : null
  const spent = minor(raw.amount_spent)
  return {
    currency: raw.currency ?? 'USD',
    spendCap: cap,
    amountSpent: spent,
    balance: minor(raw.balance),
    remaining: cap === null ? null : Math.max(0, cap - spent),
  }
}

export async function fetchCampaignDailyBudgetBdt(campaignId: string): Promise<number> {
  const data = await adsApi<{ daily_budget?: string }>(
    campaignId,
    { fields: 'daily_budget' },
  )
  return data.daily_budget ? Math.round(safeNum(data.daily_budget) / 100) : 0
}
