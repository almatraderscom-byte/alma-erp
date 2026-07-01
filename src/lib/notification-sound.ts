/** Alma ERP custom notification sound — Web, PWA, and in-app playback. */

export const NOTIFICATION_SOUND_PATH = '/sounds/alma-notification.mp3'

/** Android res/raw resource name (no extension) — see AlmaPushChannels.java */
export const ANDROID_NOTIFICATION_SOUND_RAW = 'alma_alert'

/**
 * Native Android NotificationChannel id (see AlmaPushChannels.java).
 * Bumped to _v2 because a channel's sound is immutable after creation — Android
 * "tombstones" a channel id, so reusing the old `alma_alerts` id kept the old
 * (default) sound even after delete/recreate. A fresh id forces the custom
 * `alma_alert.mp3` sound to take effect. Must stay in sync with the Java constant.
 */
export const ANDROID_NOTIFICATION_CHANNEL_ID = 'alma_alerts_v2'

let audio: HTMLAudioElement | null = null

export function notificationSoundUrl(baseUrl?: string): string {
  const origin =
    baseUrl
    || (typeof window !== 'undefined' ? window.location.origin : '')
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://alma-erp-six.vercel.app'
  const normalized = origin.startsWith('http') ? origin : `https://${origin}`
  return `${normalized.replace(/\/$/, '')}${NOTIFICATION_SOUND_PATH}`
}

/** Play Alma notification tone (Web/PWA foreground + service worker relay). */
export function playAlmaNotificationSound(): void {
  if (typeof window === 'undefined') return
  try {
    if (!audio) {
      audio = new Audio(NOTIFICATION_SOUND_PATH)
      audio.preload = 'auto'
    }
    audio.currentTime = 0
    void audio.play().catch(() => {
      /* autoplay policy — user may need interaction first */
    })
  } catch {
    /* ignore */
  }
}

export const NOTIFICATION_SOUND_SW_MESSAGE = 'ALMA_PLAY_NOTIFICATION_SOUND' as const
