/** Mirror of src/agent/lib/duty-enabled.ts — read same KV from Supabase. */

const KEY = 'duty_enabled'

const LOCKED = new Set(['salah_init'])

export function parseDutyEnabledMap(raw) {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    return typeof o === 'object' && o && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

export async function getDutyEnabledMap(supabase) {
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', KEY).maybeSingle()
  return parseDutyEnabledMap(data?.value)
}

export function isDutyEnabledSync(dutyKey, map) {
  if (LOCKED.has(dutyKey)) return true
  return map[dutyKey] !== false
}

export async function isDutyEnabled(supabase, dutyKey) {
  const map = await getDutyEnabledMap(supabase)
  return isDutyEnabledSync(dutyKey, map)
}
