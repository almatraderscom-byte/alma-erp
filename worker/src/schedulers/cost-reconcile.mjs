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
      return
    }
    const data = await res.json()
    if (data.drift && data.drift.length > 0) {
      for (const d of data.drift) {
        if (d.pctDrift > 15) {
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
  } catch (err) {
    console.error('[cost-reconcile] failed:', err.message)
  }
}
