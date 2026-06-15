/**
 * Nightly cost reconciliation — compare logged vs provider usage where API permits.
 */
import { notify } from '../notify/index.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCostReconciliation() {
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/cost-reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
    })
    if (!res.ok) {
      console.warn(`[cost-reconcile] HTTP ${res.status}`)
      return { dutyStatus: 'error', dutyDetail: `API error: HTTP ${res.status}` }
    }
    const data = await res.json()
    const driftItems = data.drift ?? []
    const alerts = []
    if (driftItems.length > 0) {
      for (const d of driftItems) {
        if (d.pctDrift > 15) {
          alerts.push(d.provider)
          await notify({
            tier: 1,
            title: `Cost drift: ${d.provider}`,
            message: `Logged $${d.loggedUsd.toFixed(4)} vs reported $${d.reportedUsd.toFixed(4)} (${d.pctDrift.toFixed(1)}% drift)`,
            category: 'urgent',
          })
        }
      }
    }
    console.log('[cost-reconcile] done', data)
    const detail = alerts.length
      ? `${driftItems.length} provider চেক, ${alerts.length} drift alert (${alerts.join(', ')})`
      : `${driftItems.length} provider চেক, কোনো drift নেই`
    return { dutyStatus: 'done', dutyDetail: detail }
  } catch (err) {
    console.error('[cost-reconcile] failed:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Reconcile ব্যর্থ: ${err.message.slice(0, 40)}` }
  }
}
