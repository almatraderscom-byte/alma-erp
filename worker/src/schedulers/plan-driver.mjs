/**
 * Plan-Driver tick (worker side) — thin trigger.
 *
 * The autonomous "pursue-until-completion" logic lives in the Next app
 * (/api/assistant/internal/plan-driver-tick, where Prisma + the planner are).
 * This worker job just fires that endpoint on a cron and logs the result.
 *
 * Self-gated: AGENT_AUTODRIVE_ENABLED is the env kill-switch (default OFF). When
 * off we don't even make the HTTP call — zero activity, zero cost. The endpoint
 * re-checks the same switch (defence in depth).
 *
 * Phase B: the endpoint is LIVE — each tick advances drivable plans by one bounded
 * step (Qwen head turn), runs the completion gate, and escalates stalls/cost-caps.
 * Caps are enforced before any paid work; with the kill-switch OFF it stays inert.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'

export async function runPlanDriverTick() {
  if (process.env.AGENT_AUTODRIVE_ENABLED !== 'true') {
    return { dutyStatus: 'skipped', dutyDetail: 'autodrive disabled (AGENT_AUTODRIVE_ENABLED!=true)' }
  }

  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/plan-driver-tick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn(`[plan-driver] HTTP ${res.status}`)
      return { dutyStatus: 'error', dutyDetail: `API error: HTTP ${res.status}` }
    }
    const data = await res.json()
    if (data.skipped) {
      return { dutyStatus: 'skipped', dutyDetail: data.reason ?? 'skipped' }
    }
    const n = data.drivablePlans ?? 0
    const driven = data.driven ?? n
    console.log(`[plan-driver] ${data.mode ?? 'live'} tick — ${driven}/${n} plan(s) driven`, JSON.stringify(data.report ?? []))
    const detail = `${data.mode ?? 'live'} — ${driven}/${n} plan, খরচ ${data.spentTodayTaka ?? 0}/${data.dailyCapTaka ?? 0} টাকা`
    return { dutyStatus: 'done', dutyDetail: detail }
  } catch (err) {
    console.error('[plan-driver] failed:', err.message)
    return { dutyStatus: 'error', dutyDetail: `Plan-driver ব্যর্থ: ${err.message.slice(0, 40)}` }
  }
}
