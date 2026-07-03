'use client'

import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { isCapacitorNative } from '@/lib/capacitor-native'
import { syncLivePulse } from '@/lib/live-pulse'

/**
 * Keeps the iOS "Business Pulse" Live Activity in sync.
 *
 * On mount and whenever the app returns to the foreground (Capacitor 'resume'),
 * it refreshes the Live Activity with today's order pulse (via syncLivePulse) so
 * the lock screen + Dynamic Island stay current. Throttled to at most once per
 * 5 minutes so a quick tab-away doesn't hammer the API.
 *
 * Mounted from GlobalPlatformChrome. No-op off the native shell; fully fail-open.
 */

const THROTTLE_MS = 5 * 60 * 1000
const LAST_SYNC_KEY = 'alma_live_pulse_last_sync'

function syncIfNotThrottled(): void {
  try {
    const last = parseInt(localStorage.getItem(LAST_SYNC_KEY) ?? '', 10)
    if (Number.isFinite(last) && Date.now() - last < THROTTLE_MS) return
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()))
  } catch {
    /* storage unavailable — fall through and sync anyway */
  }
  void syncLivePulse()
}

export function LivePulseManager() {
  useEffect(() => {
    if (!isCapacitorNative()) return
    let resumeHandle: { remove: () => void } | undefined

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
    })()

    return () => {
      resumeHandle?.remove()
    }
  }, [])

  return null
}
