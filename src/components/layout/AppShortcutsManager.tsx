'use client'

import { useEffect } from 'react'
import { AppShortcuts } from '@capawesome/capacitor-app-shortcuts'
import { isCapacitorNative } from '@/lib/capacitor-native'
import { registerAppShortcuts, shortcutPath } from '@/lib/app-shortcuts'

/**
 * Registers home-screen quick actions once and routes taps into the app.
 * Mounted from GlobalPlatformChrome. No-op off the native shell.
 */
export function AppShortcutsManager() {
  useEffect(() => {
    if (!isCapacitorNative()) return
    let handle: { remove: () => void } | undefined

    void registerAppShortcuts()
    void (async () => {
      try {
        handle = await AppShortcuts.addListener('click', ({ shortcutId }) => {
          const path = shortcutPath(shortcutId)
          if (path) window.location.assign(path)
        })
      } catch {
        /* listener is best-effort */
      }
    })()

    return () => {
      handle?.remove()
    }
  }, [])

  return null
}
