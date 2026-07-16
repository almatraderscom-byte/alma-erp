/**
 * Ads Monitoring — 09:30 Asia/Dhaka daily digest
 * Read-only: fetches spend, CTR, CPC, ROAS per active campaign.
 * Anomaly alert: CTR -40% vs 7-day avg → creative-refresh task suggestion.
 * No write ops this phase.
 */

import { notify } from '../notify/index.mjs'

const META_ADS_TOKEN  = () => process.env.META_ADS_TOKEN ?? ''
const AD_ACCOUNT_ID   = () => process.env.META_AD_ACCOUNT_ID ?? ''
// Phase 45: same env override as src/agent/lib/marketing/meta-version.ts
// (worker cannot import TS). Default = the contract-tested version; never blind-bump.
const META_GRAPH_VERSION = () =>
  /^v\d{2}\.\d$/.test(process.env.META_GRAPH_VERSION ?? '') ? process.env.META_GRAPH_VERSION : 'v21.0'

async function adsApi(path, params = {}) {
  const token = META_ADS_TOKEN()
  if (!token) throw new Error('META_ADS_TOKEN not set')
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION()}/${path}`)
  url.searchParams.set('access_token', token)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Ads API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

function safeNum(v) {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

// ---------------------------------------------------------------------------
// Phase 45 — pure anomaly detectors (unit-tested in __tests__/monitor.test.mjs)
// ---------------------------------------------------------------------------

/** CTR collapsed vs the 7-day average → creative refresh signal. */
export function detectCtrAnomaly({ todayCtr, weekCtr, spend }) {
  if (!(weekCtr > 0) || !(spend > 0)) return null
  if (todayCtr >= weekCtr * 0.6) return null
  return {
    kind: 'ctr_drop',
    dropPct: Math.round((1 - todayCtr / weekCtr) * 100),
    detail: `CTR আজ ${(todayCtr * 100).toFixed(2)}% (৭-দিন গড় ${(weekCtr * 100).toFixed(2)}%) — নতুন creative দরকার`,
  }
}

/**
 * Spend pacing vs the set daily budget. Meta legitimately flexes a day up to
 * ~75% over budget (weekly average holds) — that is a warn; beyond 1.75× is a
 * real anomaly worth an alert.
 */
export function detectSpendAnomaly({ todaySpendBdt, dailyBudgetBdt }) {
  if (!(dailyBudgetBdt > 0) || !(todaySpendBdt >= 0)) return null
  const ratio = todaySpendBdt / dailyBudgetBdt
  if (ratio > 1.75) {
    return { kind: 'overspend', severity: 'high', ratio: Math.round(ratio * 100) / 100, detail: `আজ ৳${Math.round(todaySpendBdt)} খরচ — daily budget ৳${Math.round(dailyBudgetBdt)}-এর ${Math.round(ratio * 100)}%` }
  }
  if (ratio > 1.25) {
    return { kind: 'pacing_high', severity: 'medium', ratio: Math.round(ratio * 100) / 100, detail: `Pacing বেশি: আজ budget-এর ${Math.round(ratio * 100)}% — Meta-র স্বাভাবিক flex সীমার ভেতরে, নজরে রাখুন` }
  }
  return null
}

/** Audience frequency creeping into fatigue territory. */
export function detectFrequencyFatigue({ frequency }) {
  if (!(frequency > 0)) return null
  if (frequency <= 4) return null
  return { kind: 'frequency_fatigue', frequency: Math.round(frequency * 10) / 10, detail: `Frequency ${frequency.toFixed(1)} (>4) — একই মানুষ বারবার ad দেখছে; creative rotate বা audience বড় করুন` }
}

export async function runAdsMonitor({ supabase }) {
  if (!META_ADS_TOKEN() || !AD_ACCOUNT_ID()) {
    console.warn('[ads] META_ADS_TOKEN or META_AD_ACCOUNT_ID not set — skipping')
    return { dutyStatus: 'skipped', dutyDetail: 'Ads credentials not configured' }
  }

  console.log('[ads] fetching campaign insights...')

  try {
    // Get active campaigns
    const campaigns = await adsApi(
      `${AD_ACCOUNT_ID()}/campaigns`,
      { effective_status: '["ACTIVE"]', fields: 'id,name,daily_budget', limit: 20 },
    )

    if (!campaigns.data?.length) {
      console.log('[ads] no active campaigns found')
      return { dutyStatus: 'done', dutyDetail: 'কোনো সক্রিয় ক্যাম্পেইন নেই' }
    }

    // Get today's insights + 7-day avg
    const today     = new Date().toISOString().slice(0, 10)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10)

    const insightRows = []
    const anomalies   = []

    for (const campaign of campaigns.data) {
      try {
        const todayData = await adsApi(
          `${campaign.id}/insights`,
          {
            time_range: JSON.stringify({ since: today, until: today }),
            fields: 'spend,impressions,clicks,ctr,cpc,actions,frequency',
          },
        )

        const weekData = await adsApi(
          `${campaign.id}/insights`,
          {
            time_range: JSON.stringify({ since: sevenDaysAgo, until: today }),
            fields: 'spend,impressions,clicks,ctr,cpc',
          },
        )

        const todayInsight = todayData.data?.[0] ?? {}
        const weekInsight  = weekData.data?.[0] ?? {}

        const spend  = safeNum(todayInsight.spend)
        const ctr    = safeNum(todayInsight.ctr)
        const cpc    = safeNum(todayInsight.cpc)
        const clicks = safeNum(todayInsight.clicks)

        // Calculate ROAS from actions (purchase value / spend)
        const purchaseActions = (todayInsight.actions ?? [])
          .filter(a => a.action_type === 'purchase')
        const purchaseValue = purchaseActions
          .reduce((s, a) => s + safeNum(a.value), 0)
        const roas = spend > 0 ? (purchaseValue / spend) : 0

        const weekCtr = safeNum(weekInsight.ctr)

        insightRows.push({
          name: campaign.name,
          spend: spend.toFixed(0),
          ctr:   (ctr * 100).toFixed(2) + '%',
          cpc:   cpc.toFixed(2),
          roas:  roas.toFixed(2),
        })

        // Phase 45 anomaly detection (pure helpers above): CTR collapse,
        // spend pacing vs daily budget, audience frequency fatigue.
        const found = [
          detectCtrAnomaly({ todayCtr: ctr, weekCtr, spend }),
          detectSpendAnomaly({ todaySpendBdt: spend, dailyBudgetBdt: safeNum(campaign.daily_budget) / 100 }),
          detectFrequencyFatigue({ frequency: safeNum(todayInsight.frequency) }),
        ].filter(Boolean)
        for (const a of found) anomalies.push({ campaign: campaign.name, detail: a.detail })
      } catch (err) {
        console.warn(`[ads] insight fetch for ${campaign.name} failed:`, err.message)
      }
    }

    if (!insightRows.length) {
      console.log('[ads] no insight data available yet for today')
      return { dutyStatus: 'done', dutyDetail: 'আজকের ডেটা এখনো পাওয়া যায়নি' }
    }

    // Build digest message
    const tableLines = insightRows.map(r =>
      `• *${r.name}*: ৳${r.spend} spend, CTR ${r.ctr}, CPC ${r.cpc}, ROAS ${r.roas}x`
    ).join('\n')

    let anomalySection = ''
    if (anomalies.length > 0) {
      const anomalyLines = anomalies.map(a => `⚠️ *${a.campaign}*: ${a.detail}`).join('\n')
      anomalySection = `\n\n🚨 *অ্যানোমালি:*\n${anomalyLines}`
    }

    const message =
      `📢 *Ads Daily Digest — ${today}*\n\n` +
      tableLines +
      anomalySection

    await notify({
      tier:     1,
      title:    'Ads Daily Digest',
      message,
      category: 'report',
    })

    const totalSpend = insightRows.reduce((s, r) => s + parseFloat(r.spend), 0)
    console.log(`[ads] digest sent — ${insightRows.length} campaigns, ${anomalies.length} anomalies`)
    return {
      dutyStatus: 'done',
      dutyDetail: `${insightRows.length} ক্যাম্পেইন, ৳${totalSpend.toFixed(0)} spend, ${anomalies.length} anomaly`,
    }
  } catch (err) {
    console.error('[ads] monitor error:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Ads error: ${err.message.slice(0, 50)}` }
  }
}
