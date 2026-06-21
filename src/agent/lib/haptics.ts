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

function webVibrate(ms = 14): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(ms) // soft, brief tap — barely-there, not a buzz
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

/**
 * A single light "tick" used by the loading spinner, fired repeatedly in sync
 * with the animation rhythm. Same native-first routing as agentReplyHaptic:
 * the iPhone Taptic Engine fires on the native app (even though iOS Safari /
 * WKWebView ignores navigator.vibrate); web/Android fall back to vibrate.
 *
 * @param webMs vibration length (ms) for the Web Vibration fallback only.
 */
export function agentTickHaptic(webMs = 12): void {
  if (isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => webVibrate(webMs))
    return
  }
  webVibrate(webMs)
}
