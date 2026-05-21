/**
 * Shared client device detection for observability tagging.
 *
 * Returned shape is deliberately minimal and stable so it can flow into
 * structured logs AND Sentry scope tags without invalidating dashboards.
 * All helpers are SSR-safe — they return false on the server.
 */

export type DeviceFlags = {
  mobile: boolean
  ios: boolean
  android: boolean
  safari: boolean
  pwa: boolean
}

const SAFARI_RE = /safari/i
const SAFARI_EXCLUDE_RE = /crios|fxios|edgios|chrome\//i

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '')
}

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android/i.test(navigator.userAgent || '')
}

export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return SAFARI_RE.test(ua) && !SAFARI_EXCLUDE_RE.test(ua)
}

export function isPWA(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    /* matchMedia may throw inside WebViews */
  }
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return nav?.standalone === true
}

export function readDeviceFlags(): DeviceFlags {
  const ios = isIOS()
  return {
    ios,
    android: isAndroid(),
    safari: isSafari(),
    pwa: isPWA(),
    mobile: ios || isAndroid(),
  }
}

/** Flat key/value tags for Sentry.setTag (no nested values). */
export function deviceSentryTags(): Record<string, string> {
  const d = readDeviceFlags()
  return {
    'device.mobile': String(d.mobile),
    'device.ios': String(d.ios),
    'device.android': String(d.android),
    'device.safari': String(d.safari),
    'device.pwa': String(d.pwa),
  }
}
