export type UsageThreshold = 'normal' | 'warning' | 'critical'

export function getUsageThreshold(value: number | null): UsageThreshold {
  if (value != null && value >= 90) return 'critical'
  if (value != null && value >= 70) return 'warning'
  return 'normal'
}
