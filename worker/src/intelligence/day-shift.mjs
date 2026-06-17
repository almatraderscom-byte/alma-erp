/**
 * Day Shift runner — autonomous office session in owner agent chat.
 * Calls Vercel internal API — cycle start at 00:05 Dhaka (midnight), tick every 12 min (24h).
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function callDayShift(action) {
  if (!APP_URL() || !INT()) {
    console.warn('[day-shift] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return { ok: false, detail: 'env_missing' }
  }
  const res = await fetch(`${APP_URL()}/api/assistant/internal/day-shift`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INT()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(90_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.warn('[day-shift] API', res.status, data)
    return { ok: false, detail: `http_${res.status}` }
  }
  return data
}

/** 08:00 Dhaka — open shift + first task. */
export async function runDayShiftStart() {
  console.log('[day-shift] morning start...')
  const result = await callDayShift('start')
  if (result.ok) {
    const tick = await callDayShift('tick')
    return { dutyStatus: 'done', dutyDetail: `${result.detail}; ${tick.detail ?? 'tick'}` }
  }
  return { dutyStatus: 'skipped', dutyDetail: result.detail ?? 'start_failed' }
}

/** 08:00 Dhaka — morning summary for owner (shift runs at midnight). */
export async function runDayShiftMorningBrief() {
  console.log('[day-shift] morning brief...')
  const result = await callDayShift('morning_brief')
  return {
    dutyStatus: result.ok ? 'done' : 'skipped',
    dutyDetail: result.detail ?? 'morning_brief_failed',
  }
}

/** Every 12 min during office hours — run next task. */
export async function runDayShiftTick() {
  const result = await callDayShift('tick')
  return {
    dutyStatus: result.ok ? 'done' : 'skipped',
    dutyDetail: result.detail ?? 'tick_failed',
  }
}
