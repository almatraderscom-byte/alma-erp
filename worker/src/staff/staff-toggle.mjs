/**
 * Owner on/off switches for staff-facing agent behaviours.
 *
 * KV key `staff_task_enabled`: JSON map { [behaviourKey]: boolean }. Absent key = enabled.
 * Mirrors the app-side route at /api/assistant/staff-toggles.
 *
 * Behaviour keys:
 *   proof_request    — random "send a photo of your work" asks
 *   slow_task_alert  — slow-task nudges to staff + short digest to owner
 *   idle_detect      — idle-staff nudges + owner alert
 *   progress_ask     — "Progress জানান" button on staff messages
 */

export const STAFF_TASK_ENABLED_KV_KEY = 'staff_task_enabled'

export function parseStaffToggleMap(raw) {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    return typeof o === 'object' && o && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

export async function getStaffToggleMap(supabase) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', STAFF_TASK_ENABLED_KV_KEY)
    .maybeSingle()
  return parseStaffToggleMap(data?.value)
}

export function isStaffTaskEnabledSync(key, map) {
  return map[key] !== false
}

export async function isStaffTaskEnabled(supabase, key) {
  const map = await getStaffToggleMap(supabase)
  return isStaffTaskEnabledSync(key, map)
}
