/**
 * Ads Monitoring — 09:30 Asia/Dhaka daily digest
 * Read-only: fetches spend, CTR, CPC, ROAS per active campaign.
 * Anomaly alert: CTR -40% vs 7-day avg → creative-refresh task suggestion.
 * No write ops this phase.
 */

import { notify } from '../notify/index.mjs'

const META_ADS_TOKEN = process.env.META_ADS_TOKEN
const AD_ACCOUNT_ID  = process.env.META_AD_ACCOUNT_ID // e.g. act_1234567890

async function adsApi(path, params = {}) {
  if (!META_ADS_TOKEN) throw new Error('META_ADS_TOKEN not set')
  const url = new URL(`https://graph.facebook.com/v21.0/${path}`)
  url.searchParams.set('access_token', META_ADS_TOKEN)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
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

export async function runAdsMonitor({ supabase }) {
  if (!META_ADS_TOKEN || !AD_ACCOUNT_ID) {
    console.warn('[ads] META_ADS_TOKEN or META_AD_ACCOUNT_ID not set — skipping')
    return { dutyStatus: 'skipped', dutyDetail: 'Ads credentials not configured' }
  }

  console.log('[ads] fetching campaign insights...')

  try {
    // Get active campaigns
    const campaigns = await adsApi(
      `${AD_ACCOUNT_ID}/campaigns`,
      { effective_status: '["ACTIVE"]', fields: 'id,name', limit: 20 },
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
            fields: 'spend,impressions,clicks,ctr,cpc,actions',
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

        // Anomaly detection: CTR -40% vs 7-day avg
        if (weekCtr > 0 && ctr < weekCtr * 0.6 && spend > 0) {
          anomalies.push({
            campaign: campaign.name,
            todayCtr: (ctr * 100).toFixed(2),
            weekCtr:  (weekCtr * 100).toFixed(2),
            drop:     Math.round((1 - ctr / weekCtr) * 100),
          })
        }
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
      const anomalyLines = anomalies.map(a =>
        `⚠️ *${a.campaign}*: CTR আজ ${a.todayCtr}% (৭-দিন গড়: ${a.weekCtr}%, ${a.drop}% কমেছে) — নতুন creative দরকার`
      ).join('\n')
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
