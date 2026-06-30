/**
 * Global mobile pull-to-refresh coordination.
 * Dedupes requests, invalidates query cache, and notifies subscribers.
 */
import { selectHaptic, successHaptic, warningHaptic } from '@/lib/ui-haptics'

export type MobileRefreshResult = {
  ok: boolean
  reason?: 'busy' | 'throttled' | 'offline' | 'error'
  error?: string
}

type RefreshHandler = () => void | Promise<void>
type RefreshListener = () => void

const handlers = new Set<RefreshHandler>()
const listeners = new Set<RefreshListener>()

let refreshLock = false
let lastRefreshAt = 0

export const MOBILE_REFRESH_MIN_INTERVAL_MS = 2_000
export const MOBILE_REFRESH_PULL_THRESHOLD_PX = 72
export const MOBILE_REFRESH_MAX_PULL_PX = 120

export function registerMobileRefreshHandler(handler: RefreshHandler) {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

export function subscribeMobileRefresh(listener: RefreshListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyMobileRefreshListeners() {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (e) {
      console.warn('[mobile-refresh] listener failed', (e as Error).message)
    }
  }
}

export function isMobileRefreshLocked() {
  return refreshLock
}

export async function performMobileRefresh(options?: {
  invalidateCache?: (prefix?: string) => void
  sessionUpdate?: () => Promise<unknown>
  force?: boolean
}): Promise<MobileRefreshResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' }
  }

  if (refreshLock) return { ok: false, reason: 'busy' }

  const now = Date.now()
  if (!options?.force && now - lastRefreshAt < MOBILE_REFRESH_MIN_INTERVAL_MS) {
    return { ok: false, reason: 'throttled' }
  }

  refreshLock = true
  lastRefreshAt = now

  try {
    options?.invalidateCache?.()
    await options?.sessionUpdate?.()

    notifyMobileRefreshListeners()

    const tasks = [...handlers].map(async handler => {
      try {
        await handler()
      } catch (e) {
        console.warn('[mobile-refresh] handler failed', (e as Error).message)
      }
    })
    await Promise.all(tasks)

    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'error', error: (e as Error).message }
  } finally {
    refreshLock = false
  }
}

export function mobileRefreshHaptic(kind: 'pull' | 'success' | 'error') {
  // Native-first (iPhone Taptic Engine on the Capacitor app); falls back to the
  // Web Vibration API on Android web and no-ops on iOS Safari / desktop.
  if (kind === 'pull') selectHaptic()
  else if (kind === 'success') successHaptic()
  else warningHaptic()
}
