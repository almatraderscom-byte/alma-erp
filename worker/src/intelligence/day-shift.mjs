/**
 * Day Shift runner — autonomous office session in owner agent chat.
 * Calls Vercel internal API — office hours 08:00–22:00 Dhaka, sparse patrol after core duties.
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

async function gateOutsideOfficeHours(supabase) {
  if (!supabase) return null
  const { getDayShiftWindowUtc, isWithinDayShiftWindowUtc } = await import('../schedulers/dayshift-settings.mjs')
  const window = await getDayShiftWindowUtc(supabase)
  if (!isWithinDayShiftWindowUtc(new Date(), window)) {
    console.log('[day-shift] tick skipped — outside office window (UTC', window, ')')
    return { dutyStatus: 'skipped', dutyDetail: 'outside_office_hours' }
  }
  return null
}

/** 08:05 Dhaka — open shift + first task. */
export async function runDayShiftStart() {
  console.log('[day-shift] office start (08:05 Dhaka)...')
  const result = await callDayShift('start')
  if (result.ok) {
    const tick = await callDayShift('tick')
    return { dutyStatus: 'done', dutyDetail: `${result.detail}; ${tick.detail ?? 'tick'}` }
  }
  return { dutyStatus: 'skipped', dutyDetail: result.detail ?? 'start_failed' }
}

/** 08:00 Dhaka — morning summary for owner. */
export async function runDayShiftMorningBrief() {
  console.log('[day-shift] morning brief...')
  const result = await callDayShift('morning_brief')
  return {
    dutyStatus: result.ok ? 'done' : 'skipped',
    dutyDetail: result.detail ?? 'morning_brief_failed',
  }
}

/** Every 12 min during office hours — run next core duty or sparse patrol. */
export async function runDayShiftTick(context = {}) {
  const gated = await gateOutsideOfficeHours(context.supabase)
  if (gated) return gated

  const result = await callDayShift('tick')
  if (result.detail === 'patrol_wait' || result.detail === 'outside_office_hours') {
    console.log(`[day-shift] tick no-op: ${result.detail}`)
  }
  return {
    dutyStatus: result.ok ? 'done' : 'skipped',
    dutyDetail: result.detail ?? 'tick_failed',
  }
}
