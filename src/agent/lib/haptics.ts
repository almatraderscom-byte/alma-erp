import { Haptics, ImpactStyle } from '@capacitor/haptics'

/**
 * Light haptic feedback for the agent chat — a subtle pulse when the agent
 * finishes a reply, like the Claude app on a phone.
 *
 * - Native app (iPhone Taptic Engine / Android): uses the Capacitor Haptics
 *   plugin. NOTE: this only works after the native app is rebuilt + reinstalled
 *   with @capacitor/haptics synced in (a Vercel deploy alone does NOT add a
 *   native plugin to the installed app).
 * - Web / older native build without the plugin: falls back to the Web
 *   Vibration API (navigator.vibrate) — works on Android, no-ops on iOS Safari
 *   (Apple doesn't support it) and on desktop.
 */
function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

function webVibrate(): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(14) // soft, brief tap — barely-there, not a buzz
  } catch {
    /* vibration blocked/unsupported — ignore */
  }
}

export function agentReplyHaptic(): void {
  if (isNativePlatform()) {
    // Real native haptic (works on iPhone too). If the plugin isn't in this
    // build yet (app not rebuilt), the call rejects — fall back to web vibrate.
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => webVibrate())
    return
  }
  webVibrate()
}
