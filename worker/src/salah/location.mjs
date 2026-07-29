/**
 * Salah location (owner rule ৪, 2026-07-29): prayer scheduling follows the
 * country/location the owner is in — Dhaka when home, Dubai when in the UAE.
 *
 * Deliberately OFFSET-BASED, not IANA/Intl: this VPS's node has broken small-ICU
 * timezone data (the 2026-07 quiet-hours incident), so all salah date math stays
 * plain UTC±offset arithmetic. BD and the Gulf have no DST, so a fixed offset is
 * exact. KV (agent_kv_settings):
 *   salah_utc_offset_min  — minutes east of UTC ('360' = Dhaka default, '240' = UAE)
 *   salah_location_label  — display label for messages/UI
 */
import { createClient } from '@supabase/supabase-js'

export const OFFSET_KEY = 'salah_utc_offset_min'
export const LABEL_KEY = 'salah_location_label'
const DEFAULT_OFFSET_MIN = 360
const CACHE_MS = 60_000

let cache = { at: 0, offsetMin: DEFAULT_OFFSET_MIN, label: 'বাংলাদেশ (ঢাকা)' }

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/** Current salah location; 60s cache, fail-open to Dhaka. */
export async function getSalahLocation() {
  if (Date.now() - cache.at < CACHE_MS) return cache
  try {
    const { data } = await getSupabase()
      .from('agent_kv_settings')
      .select('key, value')
      .in('key', [OFFSET_KEY, LABEL_KEY])
    const map = new Map((data ?? []).map((r) => [r.key, r.value]))
    const n = Number(map.get(OFFSET_KEY))
    const offsetMin = Number.isFinite(n) && n >= -720 && n <= 840 ? Math.round(n) : DEFAULT_OFFSET_MIN
    cache = {
      at: Date.now(),
      offsetMin,
      label: map.get(LABEL_KEY) || (offsetMin === DEFAULT_OFFSET_MIN ? 'বাংলাদেশ (ঢাকা)' : `UTC${offsetMin >= 0 ? '+' : ''}${offsetMin / 60}`),
    }
  } catch {
    cache = { ...cache, at: Date.now() }
  }
  return cache
}

/** Today's calendar date (YYYY-MM-DD) at the given UTC offset. */
export function offsetTodayYmd(offsetMin, now = new Date()) {
  return new Date(now.getTime() + offsetMin * 60_000).toISOString().slice(0, 10)
}

export function offsetYesterdayYmd(offsetMin, now = new Date()) {
  return new Date(now.getTime() + offsetMin * 60_000 - 86_400_000).toISOString().slice(0, 10)
}

/** Local wall-clock ymd+HH:MM at the offset → UTC instant. */
export function offsetInstant(ymd, h, min, offsetMin) {
  const [Y, M, D] = ymd.split('-').map(Number)
  return new Date(Date.UTC(Y, M - 1, D, h, min) - offsetMin * 60_000)
}

/** Weekday of a calendar date is timezone-free — Friday check for jummah. */
export function isFridayYmd(ymd) {
  const [Y, M, D] = ymd.split('-').map(Number)
  return new Date(Date.UTC(Y, M - 1, D)).getUTCDay() === 5
}
