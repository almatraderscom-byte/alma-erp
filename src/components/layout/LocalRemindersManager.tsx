'use client'

import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { isCapacitorNative } from '@/lib/capacitor-native'
import { syncLocalReminders } from '@/lib/local-reminders'

/**
 * Keeps the native app's OFFLINE reminder notifications in sync.
 *
 * On mount and whenever the app returns to the foreground (Capacitor 'resume'),
 * it re-schedules local notifications for the owner's upcoming agent reminders
 * (via syncLocalReminders) so they fire even when push/network is down. Throttled
 * to at most once per 10 minutes so a quick tab-away doesn't hammer the API.
 *
 * Also routes a notification tap into the app (→ /agent, or the reminder's
 * actionUrl). Mounted from GlobalPlatformChrome. No-op off the native shell;
 * fully fail-open.
 */

const THROTTLE_MS = 10 * 60 * 1000
const LAST_SYNC_KEY = 'alma_local_reminder_last_sync'

function syncIfNotThrottled(): void {
  try {
    const last = parseInt(localStorage.getItem(LAST_SYNC_KEY) ?? '', 10)
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()))
  } catch {
    /* storage unavailable — fall through and sync anyway */
  }
  void syncLocalReminders()
}

export function LocalRemindersManager() {
  useEffect(() => {
    if (!isCapacitorNative()) return
    let resumeHandle: { remove: () => void } | undefined
    let tapHandle: { remove: () => void } | undefined

    // Sync on mount (app open).
    syncIfNotThrottled()

    void (async () => {
      try {
        resumeHandle = await CapApp.addListener('resume', () => {
          syncIfNotThrottled()
        })
      } catch {
        /* listener is best-effort */
      }
      try {
        tapHandle = await LocalNotifications.addListener(
          'localNotificationActionPerformed',
          ({ notification }) => {
            const url =
              (notification?.extra as { actionUrl?: string } | undefined)?.actionUrl || '/agent'
            window.location.assign(url)
          },
        )
      } catch {
        /* tap routing is best-effort */
      }
    })()

    return () => {
      resumeHandle?.remove()
      tapHandle?.remove()
    }
  }, [])

  return null
}
