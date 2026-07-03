/**
 * Offline reminders for the native iOS shell.
 *
 * The native app schedules LOCAL notifications for the owner's upcoming agent
 * reminders, so they still fire on the lock screen even when push / network is
 * down. Purely additive and fail-open: ANY error is swallowed so this can never
 * affect the app.
 *
 * Native-only. `syncLocalReminders()` fetches the upcoming pending reminders from
 * /api/assistant/device-reminders, cancels the ones it scheduled last time, and
 * re-schedules the current list.
 */
import { LocalNotifications } from '@capacitor/local-notifications'
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Native builds below this number ship WITHOUT the local-notifications pod — on
 * those, touching the plugin makes iOS crash the app (the same class of failure
 * as the 2026-07-03 Face ID build-2 crash; see BiometricLockGate.tsx). The web
 * code deploys to every existing install, so we must NEVER touch the plugin on an
 * old binary.
 */
const MIN_NATIVE_BUILD = 5

/** localStorage key: the numeric ids we scheduled last sync (JSON int[]). */
const SCHEDULED_IDS_KEY = 'alma_local_reminder_ids'

interface DeviceReminder {
  id: string
  title: string
  body: string | null
  dueAt: string
}

/** Native build number, or null if it can't be read. */
async function nativeBuildNumber(): Promise<number | null> {
  try {
    const { App } = await import('@capacitor/app')
    const info = await App.getInfo()
    const build = parseInt(String(info?.build ?? ''), 10)
    return Number.isFinite(build) ? build : null
  } catch {
    return null
  }
}

/**
 * Stable positive int32 from a reminder uuid — a simple 31-hash. Notification ids
 * must be numeric (and fit a 32-bit int on Android), so we derive one from the id
 * string deterministically: the SAME reminder always maps to the SAME id, so a
 * re-sync cancels + reschedules it rather than duplicating.
 */
export function reminderNotificationId(uuid: string): number {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) {
    hash = (hash * 31 + uuid.charCodeAt(i)) | 0
  }
  return Math.abs(hash) || 1
}

function readScheduledIds(): number[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_IDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n) => typeof n === 'number' && Number.isFinite(n))
  } catch {
    return []
  }
}

function writeScheduledIds(ids: number[]): void {
  try {
    localStorage.setItem(SCHEDULED_IDS_KEY, JSON.stringify(ids))
  } catch {
    /* storage full / disabled — nothing we can do, stay fail-open */
  }
}

/**
 * Sync local notifications for the owner's upcoming reminders. Native-only,
 * fail-open. Safe to call repeatedly (e.g. on app open + resume).
 */
export async function syncLocalReminders(): Promise<void> {
  try {
    if (!isCapacitorNative()) return

    // Hard safety: never touch the plugin on a binary that lacks the pod.
    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return

    // Permission: ask at most once. If not granted, do nothing.
    let status = await LocalNotifications.checkPermissions()
    if (status.display === 'prompt' || status.display === 'prompt-with-rationale') {
      status = await LocalNotifications.requestPermissions()
    }
    if (status.display !== 'granted') return

    const res = await fetch('/api/assistant/device-reminders', {
      credentials: 'same-origin',
    })
    if (!res.ok) return
    const data = (await res.json()) as { reminders?: DeviceReminder[] }
    const reminders = Array.isArray(data?.reminders) ? data.reminders : []

    // Cancel exactly the notifications we scheduled last time.
    const previousIds = readScheduledIds()
    if (previousIds.length > 0) {
      await LocalNotifications.cancel({
        notifications: previousIds.map((id) => ({ id })),
      })
    }

    const now = Date.now()
    const toSchedule = reminders
      .map((r) => ({ r, at: new Date(r.dueAt) }))
      .filter(({ at }) => Number.isFinite(at.getTime()) && at.getTime() > now)
      .map(({ r, at }) => ({
        id: reminderNotificationId(r.id),
        title: r.title,
        body: r.body || 'ALMA ERP রিমাইন্ডার',
        schedule: { at },
        extra: { actionUrl: '/agent' },
      }))

    if (toSchedule.length > 0) {
      await LocalNotifications.schedule({ notifications: toSchedule })
    }

    writeScheduledIds(toSchedule.map((n) => n.id))
  } catch {
    /* offline reminders are a nice-to-have — never let a failure surface */
  }
}
