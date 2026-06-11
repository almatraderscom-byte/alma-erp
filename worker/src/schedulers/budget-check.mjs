/**
 * Hourly budget threshold check — 80% Tier 1, 100% Tier 2 (once per period).
 */
import { notify } from '../notify/index.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

async function fetchSpend(period) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/cost-spend?period=${period}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) throw new Error(`cost-spend HTTP ${res.status}`)
  return res.json()
}

async function markAlert(key) {
  await fetch(`${APP_URL}/api/assistant/internal/agent-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify({ key, value: new Date().toISOString() }),
  }).catch(() => {})
}

async function wasAlerted(key) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings?keys=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) return false
  const data = await res.json()
  return Boolean(data?.[key])
}

export async function runBudgetCheck() {
  try {
    const spend = await fetchSpend('both')
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const monthStr = todayStr.slice(0, 7)

    if (spend.dailyBudgetUsd && spend.todayUsd != null) {
      const pct = spend.todayUsd / spend.dailyBudgetUsd
      const key80 = `cost.alert.daily80.${todayStr}`
      const key100 = `cost.alert.daily100.${todayStr}`
      if (pct >= 1 && !(await wasAlerted(key100))) {
        await notify({
          tier: 2,
          title: 'Daily AI budget exceeded',
          message: `আজকের AI খরচ $${spend.todayUsd.toFixed(2)} — দৈনিক বাজেট $${spend.dailyBudgetUsd} অতিক্রম করেছে।`,
          category: 'urgent',
        })
        await markAlert(key100)
      } else if (pct >= 0.8 && !(await wasAlerted(key80))) {
        await notify({
          tier: 1,
          title: 'Daily AI budget 80%',
          message: `আজকের AI খরচ $${spend.todayUsd.toFixed(2)} — দৈনিক বাজেটের ৮০% (${spend.dailyBudgetUsd} USD)।`,
          category: 'urgent',
        })
        await markAlert(key80)
      }
    }

    if (spend.monthlyBudgetUsd && spend.monthUsd != null) {
      const pct = spend.monthUsd / spend.monthlyBudgetUsd
      const key80 = `cost.alert.monthly80.${monthStr}`
      const key100 = `cost.alert.monthly100.${monthStr}`
      if (pct >= 1 && !(await wasAlerted(key100))) {
        await notify({
          tier: 2,
          title: 'Monthly AI budget exceeded',
          message: `মাসের AI খরচ $${spend.monthUsd.toFixed(2)} — মাসিক বাজেট $${spend.monthlyBudgetUsd} অতিক্রম করেছে।`,
          category: 'urgent',
        })
        await markAlert(key100)
      } else if (pct >= 0.8 && !(await wasAlerted(key80))) {
        await notify({
          tier: 1,
          title: 'Monthly AI budget 80%',
          message: `মাসের AI খরচ $${spend.monthUsd.toFixed(2)} — মাসিক বাজেটের ৮০% (${spend.monthlyBudgetUsd} USD)।`,
          category: 'urgent',
        })
        await markAlert(key80)
      }
    }
  } catch (err) {
    console.error('[budget-check] failed:', err.message)
  }
}
