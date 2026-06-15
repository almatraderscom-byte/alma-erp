/**
 * Configurable salah times — worker reads agent_kv_settings (mirror src/lib/salah/time-config.ts).
 */

import { createClient } from '@supabase/supabase-js'

export const KV_KEY = 'salah_time_config'

export const DEFAULT_SALAH_TIMES = {
  fajr: { azan: '03:43', prayer: '03:43', end: '05:11' },
  dhuhr: { azan: '12:30', prayer: '13:30', end: '15:17' },
  asr: { azan: '16:30', prayer: '17:00', end: '18:30' },
  maghrib: { azan: '18:45', prayer: '18:45', end: '20:13' },
  isha: { azan: '20:13', prayer: '20:45', end: '23:00' },
}

let cached = null
let cachedAt = 0
const CACHE_MS = 60_000

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function mergeConfig(parsed) {
  const out = { ...DEFAULT_SALAH_TIMES }
  for (const waqt of Object.keys(DEFAULT_SALAH_TIMES)) {
    if (parsed?.[waqt]) out[waqt] = { ...out[waqt], ...parsed[waqt] }
  }
  return out
}

export async function getSalahTimeConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached
  try {
    const { data } = await sb()
      .from('agent_kv_settings')
      .select('value')
      .eq('key', KV_KEY)
      .maybeSingle()
    if (!data?.value) {
      cached = { ...DEFAULT_SALAH_TIMES }
    } else {
      try {
        cached = mergeConfig(JSON.parse(data.value))
      } catch {
        cached = { ...DEFAULT_SALAH_TIMES }
      }
    }
  } catch {
    cached = { ...DEFAULT_SALAH_TIMES }
  }
  cachedAt = Date.now()
  return cached
}

export function invalidateSalahTimeConfigCache() {
  cached = null
  cachedAt = 0
}
