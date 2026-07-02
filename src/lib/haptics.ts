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
 * Haptics plugin; web falls back to navigator.vibrate (Android browsers).
 * iOS Safari/PWA has no navigator.vibrate, but iOS 18+ fires a real Taptic
 * tick when an <input type="checkbox" switch> is toggled — even from a
 * programmatic label.click() inside a user gesture, and even in home-screen
 * PWAs. A hidden switch shim routes every haptic through that. Never throws.
 */

function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

// Hidden <label><input type="checkbox" switch></label> — clicking the label on
// iOS 18+ produces the system switch haptic. Older iOS ignores the attribute
// and the click is a silent no-op on the invisible checkbox.
let switchShim: HTMLLabelElement | null = null

function iosSwitchTick(): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  try {
    if (!switchShim || !switchShim.isConnected) {
      const label = document.createElement('label')
      label.setAttribute('aria-hidden', 'true')
      label.style.cssText =
        'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.setAttribute('switch', '')
      input.tabIndex = -1
      label.appendChild(input)
      document.body.appendChild(label)
      switchShim = label
    }
    switchShim.click()
    return true
  } catch {
    return false
  }
}

function webVibrate(ms: number): void {
  if (typeof navigator === 'undefined') return
  if (typeof navigator.vibrate !== 'function') {
    // iOS Safari/PWA path — no Vibration API; use the iOS 18 switch haptic.
    iosSwitchTick()
    return
  }
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

function webNotifyVibrate(webPattern: number | number[]): void {
  if (typeof navigator === 'undefined') return
  if (typeof navigator.vibrate !== 'function') {
    iosSwitchTick()
    return
  }
  try { navigator.vibrate(webPattern) } catch { /* ignore */ }
}

function notify(type: NotificationType, webPattern: number | number[]): void {
  if (isNativePlatform()) {
    Haptics.notification({ type }).catch(() => webNotifyVibrate(webPattern))
    return
  }
  webNotifyVibrate(webPattern)
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
