/** KV toggle: office-hours continuous location monitoring (geo-monitor cron). Attendance GPS is separate. */
export const GEO_FENCE_MONITORING_KEY = 'geo_fence_monitoring_enabled'

export function parseGeoFenceMonitoringEnabled(value: string | null | undefined): boolean {
  if (value == null || value === '') return true
  const v = value.trim().toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'off'
}

export async function getGeoFenceMonitoringEnabled(): Promise<boolean> {
  const row = await (await import('@/lib/prisma')).prisma.agentKvSetting.findUnique({
    where: { key: GEO_FENCE_MONITORING_KEY },
  })
  return parseGeoFenceMonitoringEnabled(row?.value)
}

export async function setGeoFenceMonitoringEnabled(enabled: boolean): Promise<void> {
  const { prisma } = await import('@/lib/prisma')
  await prisma.agentKvSetting.upsert({
    where: { key: GEO_FENCE_MONITORING_KEY },
    create: { key: GEO_FENCE_MONITORING_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  })
}
