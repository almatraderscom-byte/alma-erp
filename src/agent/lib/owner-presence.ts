/**
 * Owner app-presence tracking. The client writes an explicit lifecycle state so
 * backgrounding takes effect immediately instead of waiting for the old 50-second
 * heartbeat window to expire.
 */
import { prisma } from '@/lib/prisma'

const KEY = 'owner.appActiveAt'
/** Client pings ~every 20s while visible; 50s window tolerates a missed ping. */
const ACTIVE_WINDOW_MS = 50_000
export type OwnerAppPresenceState = 'active' | 'background'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Record the owner's current app lifecycle state. */
export async function markOwnerAppPresence(state: OwnerAppPresenceState): Promise<void> {
  const value = JSON.stringify({ at: Date.now(), state })
  await db.agentKvSetting.upsert({
    where: { key: KEY },
    update: { value },
    create: { key: KEY, value },
  })
}

/** Backwards-compatible helper for older server callers. */
export async function markOwnerAppActive(): Promise<void> {
  await markOwnerAppPresence('active')
}

/**
 * True if the owner's app pinged within the active window (i.e. he's looking at
 * the app now). Fail-OPEN to false (= treat as away) so a storage glitch never
 * silently swallows an away-notification.
 */
export async function isOwnerAppActive(): Promise<boolean> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: KEY } })
    if (!row?.value) return false
    const parsed = JSON.parse(row.value) as { at?: number; state?: OwnerAppPresenceState }
    const at = parsed.at ?? 0
    // Legacy rows had no state and meant "active"; new background writes suppress
    // that legacy interpretation immediately.
    return parsed.state !== 'background' && Date.now() - at < ACTIVE_WINDOW_MS
  } catch {
    return false
  }
}
