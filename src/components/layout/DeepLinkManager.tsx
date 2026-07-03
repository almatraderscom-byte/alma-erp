'use client'

import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Routes almaerp:// custom-scheme deep links (Siri App Intents, future
 * widgets/notifications) into the app. Capacitor delivers them as appUrlOpen;
 * `almaerp://orders` → navigate to `/orders`. Fail-open: unknown or malformed
 * URLs are ignored; on old binaries without the scheme the event never fires.
 */
export function DeepLinkManager() {
  useEffect(() => {
    if (!isCapacitorNative()) return
    let handle: { remove: () => void } | undefined
    void (async () => {
      try {
        handle = await CapApp.addListener('appUrlOpen', ({ url }) => {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'almaerp:') return
            // almaerp://orders/123?x=1 → /orders/123?x=1 (host carries the first segment)
            const path = `/${parsed.host}${parsed.pathname}${parsed.search}`.replace(/\/+$/, '') || '/'
            window.location.assign(path)
          } catch {
            /* malformed deep link — ignore */
          }
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
