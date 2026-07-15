/** Canonical autonomous-heartbeat schedule. Keep this expression in sync with vercel.json. */
export const HEARTBEAT_CRON = '0 4,7,10,13 * * *'
export const HEARTBEAT_UTC_HOURS = [4, 7, 10, 13] as const

/** Next Vercel heartbeat check after `now` (the cron is UTC). */
export function nextHeartbeatCheckAt(now = new Date()): Date {
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const day = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, 0, 0, 0, 0,
    ))
    for (const hour of HEARTBEAT_UTC_HOURS) {
      const candidate = new Date(day)
      candidate.setUTCHours(hour)
      if (candidate.getTime() > now.getTime()) return candidate
    }
  }
  // The two-day search is exhaustive, but keep a deterministic fail-safe.
  const fallback = new Date(now)
  fallback.setUTCDate(fallback.getUTCDate() + 1)
  fallback.setUTCHours(HEARTBEAT_UTC_HOURS[0], 0, 0, 0)
  return fallback
}
