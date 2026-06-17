/** Mirror of src/agent/lib/dayshift-settings.ts — Supabase KV reads. */

export const DAYSHIFT_WINDOW_UTC_KEY = 'dayshift_window_utc'
export const DAYSHIFT_PATROL_INTERVAL_KEY = 'dayshift_patrol_interval_min'

export const DEFAULT_DAYSHIFT_WINDOW_UTC = '2-16'
export const DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN = 60

export function buildDayShiftTickCron(windowUtc = DEFAULT_DAYSHIFT_WINDOW_UTC) {
  const w = (windowUtc ?? '').trim() || DEFAULT_DAYSHIFT_WINDOW_UTC
  return `*/12 ${w} * * *`
}

export function parseDayShiftWindowUtc(value) {
  const v = value?.trim()
  if (!v) return DEFAULT_DAYSHIFT_WINDOW_UTC
  if (/^\d{1,2}-\d{1,2}$/.test(v)) return v
  return DEFAULT_DAYSHIFT_WINDOW_UTC
}

export function parsePatrolIntervalMin(value) {
  if (value == null || value === '') return DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 15 || n > 240) return DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN
  return n
}

export function isWithinDayShiftWindowUtc(now = new Date(), windowUtc = DEFAULT_DAYSHIFT_WINDOW_UTC) {
  const w = parseDayShiftWindowUtc(windowUtc)
  const [startStr, endStr] = w.split('-')
  const start = parseInt(startStr, 10)
  const end = parseInt(endStr, 10)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true
  const hourUtc = now.getUTCHours()
  return hourUtc >= start && hourUtc <= end
}

export async function getDayShiftWindowUtc(supabase) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', DAYSHIFT_WINDOW_UTC_KEY).maybeSingle()
  return parseDayShiftWindowUtc(data?.value)
}

export async function getDayShiftPatrolIntervalMin(supabase) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', DAYSHIFT_PATROL_INTERVAL_KEY).maybeSingle()
  return parsePatrolIntervalMin(data?.value)
}

export async function getDayShiftTickCron(supabase) {
  const window = await getDayShiftWindowUtc(supabase)
  return buildDayShiftTickCron(window)
}
