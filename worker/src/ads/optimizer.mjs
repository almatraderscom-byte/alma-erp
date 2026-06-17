/**
 * Ads Optimizer — 09:45 Asia/Dhaka daily (after ads-monitor).
 * Creates ONE owner approval card when actionable recommendations exist.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
export async function runAdsOptimizer() {
  if (!getAppUrl() || !getInternalToken()) {
    console.warn('[ads-optimizer] getAppUrl() or AGENT_INTERNAL_TOKEN not set — skipping')
    return { dutyStatus: 'skipped', dutyDetail: 'Internal API not configured' }
  }

  if (!process.env.META_ADS_TOKEN || !process.env.META_AD_ACCOUNT_ID) {
    console.warn('[ads-optimizer] Meta ads credentials not set — skipping')
    return { dutyStatus: 'skipped', dutyDetail: 'Meta ads credentials not configured' }
  }

  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/ads-optimizer-run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getInternalToken()}` },
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    if (data.skipped) {
      console.log('[ads-optimizer] no actionable recs — skipped card')
      return { dutyStatus: 'done', dutyDetail: 'কোনো actionable rec নেই (hold)' }
    }
    console.log(`[ads-optimizer] batch card sent — ${data.actionableCount} actionable`)
    return {
      dutyStatus: 'done',
      dutyDetail: `${data.actionableCount} actionable rec — approval card sent`,
    }
  } catch (err) {
    console.error('[ads-optimizer] error:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Optimizer error: ${err.message.slice(0, 50)}` }
  }
}
