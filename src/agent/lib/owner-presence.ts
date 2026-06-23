/**
 * Owner app-presence tracking — so agent push (ntfy) fires ONLY when the owner
 * is NOT actively in the agent app. The app pings markOwnerAppActive() while it
 * is foreground (visible); a notification path calls isOwnerAppActive() and
 * skips the push if the owner is currently looking at the app.
 */
import { prisma } from '@/lib/prisma'

const KEY = 'owner.appActiveAt'
/** Client pings ~every 20s while visible; 50s window tolerates a missed ping. */
const ACTIVE_WINDOW_MS = 50_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Record that the owner's agent app is foreground right now. */
export async function markOwnerAppActive(): Promise<void> {
  const value = JSON.stringify({ at: Date.now() })
  await db.agentKvSetting.upsert({
    where: { key: KEY },
    update: { value },
    create: { key: KEY, value },
  })
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
    const at = (JSON.parse(row.value) as { at?: number }).at ?? 0
    return Date.now() - at < ACTIVE_WINDOW_MS
  } catch {
    return false
  }
}
