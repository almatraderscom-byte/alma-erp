/**
 * App-wide UI haptics — a tasteful tactile layer for the native iOS/Android app.
 *
 * Native-first routing (mirrors src/agent/lib/haptics.ts): on the Capacitor app
 * the iPhone Taptic Engine / Android vibrator fire via @capacitor/haptics; on
 * web / older native builds without the plugin it falls back to the Web
 * Vibration API (works on Android web, silently no-ops on iOS Safari + desktop).
 * Every function is a safe no-op when nothing is available — callers never guard.
 *
 * NOTE: on the iOS app the real Taptic Engine only fires once the native app has
 * been rebuilt + reinstalled with @capacitor/haptics bundled (a Vercel deploy
 * alone can't add a native plugin). Until then these degrade gracefully to
 * nothing on iOS — the code is correct and premium-ready regardless.
 *
 * Use sparingly and meaningfully:
 *   tapHaptic()     — a button / primary tap (light)
 *   selectHaptic()  — a selection change: tab, toggle, filter pill (lighter)
 *   successHaptic() — an action succeeded: approve, save, submit (notification)
 *   warningHaptic() — a destructive / error confirmation (notification)
 */
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

function webVibrate(ms: number | number[] = 12): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(ms)
  } catch {
    /* blocked/unsupported — ignore */
  }
}

/** Light tap — buttons, primary actions. */
export function tapHaptic(): void {
  if (isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => webVibrate(10))
    return
  }
  webVibrate(10)
}

/** Even lighter — selection changes (tabs, toggles, filter pills). */
export function selectHaptic(): void {
  if (isNativePlatform()) {
    Haptics.selectionChanged().catch(() => webVibrate(8))
    return
  }
  webVibrate(8)
}

/** Success notification — approve / save / submit completed. */
export function successHaptic(): void {
  if (isNativePlatform()) {
    Haptics.notification({ type: NotificationType.Success }).catch(() => webVibrate([10, 40, 16]))
    return
  }
  webVibrate([10, 40, 16])
}

/** Warning notification — destructive confirm / error. */
export function warningHaptic(): void {
  if (isNativePlatform()) {
    Haptics.notification({ type: NotificationType.Warning }).catch(() => webVibrate([14, 50, 14]))
    return
  }
  webVibrate([14, 50, 14])
}
