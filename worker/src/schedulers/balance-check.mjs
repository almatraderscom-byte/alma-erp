/**
 * Every 15 minutes — refresh provider billing snapshots + low wallet Tier 1 alerts.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
import { notify } from '../notify/index.mjs'

async function wasAlerted(key) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/agent-settings?keys=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${getInternalToken()}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return false
  const data = await res.json()
  return Boolean(data?.[key])
}

async function markAlert(key) {
  await fetch(`${getAppUrl()}/api/assistant/internal/agent-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({ key, value: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    console.warn('[balance-check] markAlert failed:', key, err.message)
  })
}

export async function runBalanceCheck() {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/balance-refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      console.warn(`[balance-check] HTTP ${res.status}`)
      return
    }

    const data = await res.json()
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

    for (const alert of data.alerts ?? []) {
      // severity/reason/runwayDays are Phase D additions; older app builds omit
      // them, so every read below tolerates undefined.
      const severity = alert.severity || 'action'
      const emoji = severity === 'emergency' ? '🔴' : '⚠️'
      const balanceStr = `$${Number(alert.balanceUsd ?? 0).toFixed(2)}`
      const runwayNote = alert.reason === 'low_runway' && alert.runwayDays != null
        ? ` — আনুমানিক ${alert.runwayDays} দিন চলবে`
        : ''

      // Include severity in the dedup key so an escalation (action → emergency)
      // re-alerts the same day, while repeats at the same level stay quiet.
      const key = `cost.alert.lowbalance.${alert.provider}.${severity}.${todayStr}`
      if (await wasAlerted(key)) continue

      await notify({
        tier: 1,
        title: `${severity === 'emergency' ? 'URGENT — ' : ''}Low API balance: ${alert.label}`,
        message: `${emoji} ${alert.label}${runwayNote} (ব্যালেন্স ${balanceStr}) — রিচার্জ করুন`,
        category: 'urgent',
      })
      await markAlert(key)
    }

    console.log('[balance-check] done', {
      checkedAt: data.cache?.checkedAt,
      alerts: (data.alerts ?? []).length,
      twilio: data.twilioRaw,
    })
  } catch (err) {
    console.error('[balance-check] failed:', err.message)
  }
}
