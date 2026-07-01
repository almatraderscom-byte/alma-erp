import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

/**
 * App-wide haptic vocabulary — the iOS "Taptic" grammar, shared by ERP + agent.
 *
 * Grammar (mirrors Apple's UIFeedbackGenerator):
 * - selection() — the lightest tick: picker rows, toggles, keyboard typing,
 *   generic taps. Frequent, so it is rate-limited here.
 * - impactLight/Medium/Heavy() — physical "thud" scaled to the action's weight:
 *   light for chips/rows, medium for primary buttons (send, save), heavy for
 *   rare big moments only.
 * - notifySuccess/Warning/Error() — the three-state outcome buzz: approve
 *   landed, risky confirm, failed action.
 *
 * Routing: native app (iPhone Taptic Engine / Android) via the Capacitor
 * Haptics plugin; web falls back to navigator.vibrate (Android browsers) and
 * silently no-ops on iOS Safari/desktop. Never throws.
 */

function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

function webVibrate(ms: number): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(ms)
  } catch {
    /* vibration blocked/unsupported — ignore */
  }
}

function impact(style: ImpactStyle, webMs: number): void {
  if (isNativePlatform()) {
    Haptics.impact({ style }).catch(() => webVibrate(webMs))
    return
  }
  webVibrate(webMs)
}

export function impactLight(): void {
  impact(ImpactStyle.Light, 12)
}

export function impactMedium(): void {
  impact(ImpactStyle.Medium, 22)
}

export function impactHeavy(): void {
  impact(ImpactStyle.Heavy, 32)
}

// Selection ticks fire from high-frequency sources (typing, toggle sweeps) —
// rate-limit so a burst feels like the iOS keyboard, not a continuous buzz.
const SELECTION_MIN_GAP_MS = 45
let lastSelectionAt = 0

export function selection(): void {
  const now = Date.now()
  if (now - lastSelectionAt < SELECTION_MIN_GAP_MS) return
  lastSelectionAt = now
  if (isNativePlatform()) {
    // A one-shot selectionChanged needs start/end bracketing on iOS; a Light
    // impact is the same perceived tick without the session bookkeeping.
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => webVibrate(8))
    return
  }
  webVibrate(8)
}

function notify(type: NotificationType, webPattern: number | number[]): void {
  if (isNativePlatform()) {
    Haptics.notification({ type }).catch(() => {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(webPattern) } catch { /* ignore */ }
      }
    })
    return
  }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(webPattern) } catch { /* ignore */ }
  }
}

export function notifySuccess(): void {
  notify(NotificationType.Success, [14, 60, 18])
}

export function notifyWarning(): void {
  notify(NotificationType.Warning, [20, 80, 20])
}

export function notifyError(): void {
  notify(NotificationType.Error, [26, 70, 26, 70, 26])
}
