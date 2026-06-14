'use client'

import { useEffect } from 'react'
import {
  NOTIFICATION_SOUND_SW_MESSAGE,
  playAlmaNotificationSound,
} from '@/lib/notification-sound'

/**
 * Relays service-worker push events to in-app audio playback (Web/PWA).
 * Native Android APK uses res/raw/alma_alert via AlmaPushChannels.
 */
export function NotificationSoundBridge() {
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { type?: string } | null
      if (data?.type === NOTIFICATION_SOUND_SW_MESSAGE) {
        playAlmaNotificationSound()
      }
    }

    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

  return null
}
