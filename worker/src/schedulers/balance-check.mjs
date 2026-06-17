/**
 * Every 6 hours — refresh API provider balances + low-balance Tier 1 alerts.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
import { notify } from '../notify/index.mjs'

async function wasAlerted(key) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/agent-settings?keys=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${getInternalToken()}` },
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
  }).catch(() => {})
}

export async function runBalanceCheck() {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/balance-refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getInternalToken()}` },
    })
    if (!res.ok) {
      console.warn(`[balance-check] HTTP ${res.status}`)
      return
    }

    const data = await res.json()
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

    for (const alert of data.alerts ?? []) {
      const key = `cost.alert.lowbalance.${alert.provider}.${todayStr}`
      if (await wasAlerted(key)) continue

      await notify({
        tier: 1,
        title: `Low API balance: ${alert.label}`,
        message: `⚠️ ${alert.label} ব্যালেন্স $${alert.balanceUsd.toFixed(2)} — রিচার্জ করুন`,
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
