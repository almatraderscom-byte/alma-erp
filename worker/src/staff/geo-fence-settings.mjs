/** Office-hours live location monitoring toggle (attendance GPS unchanged). */
export const GEO_FENCE_MONITORING_KEY = 'geo_fence_monitoring_enabled'

export function parseGeoFenceMonitoringEnabled(value) {
  if (value == null || value === '') return true
  const v = String(value).trim().toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'off'
}

export async function isGeoFenceMonitoringEnabled(supabase) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', GEO_FENCE_MONITORING_KEY)
    .maybeSingle()
  return parseGeoFenceMonitoringEnabled(data?.value)
}
