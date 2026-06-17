import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'
import { fetchWithTimeout } from '@/lib/fetch-timeout'

/** Inline auto-reload script dedupes on this build id (see build-reload-script.ts). */
export const BUILD_RELOAD_GUARD_KEY = 'alma_build_reload_guard'
export const MANUAL_REFRESH_AT_KEY = 'alma_build_manual_refresh_at'
export const MANUAL_REFRESH_TARGET_KEY = 'alma_build_refresh_target'

const POLL_MS = 90_000
const MANUAL_REFRESH_SUPPRESS_MS = 5 * 60_000

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

export async function fetchRemoteBuildId(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout('/api/build-info', { cache: 'no-store' }, 8_000)
    if (res.ok) {
      const json = await res.json().catch(() => ({}))
      const remote = String(json?.commit || '').trim()
      if (remote) return remote
    }
  } catch {
    /* fall through to health */
  }
  try {
    const res = await fetchWithTimeout('/api/health', { cache: 'no-store' }, 8_000)
    const json = await res.json().catch(() => ({}))
    const remote = String(json?.frontend?.git_commit || '').trim()
    return remote || null
  } catch {
    return null
  }
}

export function isMeaningfulBuildId(id: string | null | undefined): id is string {
  return Boolean(id && id !== 'dev' && id !== 'local')
}

/** True when the loaded bundle is older than the live server deploy. */
export function isUpdateAvailable(
  runningBuildId: string | null | undefined,
  remoteId: string | null,
): boolean {
  if (!isMeaningfulBuildId(remoteId)) return false
  if (!isMeaningfulBuildId(runningBuildId)) return false
  return runningBuildId.trim() !== remoteId.trim()
}

export function beginManualBuildRefresh(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(MANUAL_REFRESH_AT_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

/** Suppress repeat banners after a manual refresh when iOS PWA still serves a stale bundle. */
export function shouldShowStaleBuildBanner(updateAvailable: boolean): boolean {
  if (!updateAvailable) return false
  if (typeof window === 'undefined') return updateAvailable

  let manualAt = 0
  try {
    manualAt = Number(sessionStorage.getItem(MANUAL_REFRESH_AT_KEY) || 0)
  } catch {
    return updateAvailable
  }
  if (!manualAt) return true

  const target = sessionStorage.getItem(MANUAL_REFRESH_TARGET_KEY)
  if (target && isMeaningfulBuildId(APP_BUILD_ID) && APP_BUILD_ID === target) {
    try {
      sessionStorage.removeItem(MANUAL_REFRESH_AT_KEY)
      sessionStorage.removeItem(MANUAL_REFRESH_TARGET_KEY)
    } catch {
      /* ignore */
    }
    return false
  }

  if (Date.now() - manualAt < MANUAL_REFRESH_SUPPRESS_MS) return false
  return true
}

export async function clearAppCaches(): Promise<void> {
  if (typeof window === 'undefined') return
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map(reg => reg.unregister()))
  }
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.map(key => caches.delete(key)))
  }
}

/** @deprecated use clearAppCaches */
export const clearStaleRuntimeCaches = clearAppCaches

/** Hard refresh — clears WebView/SW caches; no APK reinstall needed. */
export async function hardRefreshApp(): Promise<void> {
  beginManualBuildRefresh()

  let remoteId: string | null = null
  try {
    remoteId = await fetchRemoteBuildId()
    if (remoteId) {
      sessionStorage.setItem(MANUAL_REFRESH_TARGET_KEY, remoteId)
    }
  } catch {
    /* ignore */
  }

  try {
    await clearAppCaches()
    if (remoteId && isMeaningfulBuildId(remoteId)) {
      markBuildSynced(remoteId)
    }
  } catch {
    /* ignore */
  }

  const url = new URL(window.location.href)
  url.searchParams.set('_alma_v', String(Date.now()))
  window.location.replace(url.toString())
}

export function markBuildSynced(buildId: string): void {
  if (!isMeaningfulBuildId(buildId)) return
  try {
    localStorage.setItem(RUNTIME_BUILD_STORAGE_KEY, buildId)
  } catch {
    /* ignore */
  }
}

export function readStoredBuildId(): string | null {
  try {
    return localStorage.getItem(RUNTIME_BUILD_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Poll /api/health and compare the running bundle against the live deploy. */
export async function checkForAppUpdate(): Promise<{
  remoteId: string | null
  storedId: string | null
  updateAvailable: boolean
}> {
  const remoteId = await fetchRemoteBuildId()
  const storedId = readStoredBuildId()
  const rawUpdate = isUpdateAvailable(APP_BUILD_ID, remoteId)
  const updateAvailable = rawUpdate && shouldShowStaleBuildBanner(rawUpdate)

  if (!rawUpdate && isMeaningfulBuildId(remoteId)) {
    markBuildSynced(remoteId)
    try {
      sessionStorage.removeItem(MANUAL_REFRESH_AT_KEY)
      sessionStorage.removeItem(MANUAL_REFRESH_TARGET_KEY)
    } catch {
      /* ignore */
    }
  }

  return { remoteId, storedId, updateAvailable }
}

export function subscribeAppUpdateChecks(onUpdate: () => void, onClear?: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  let cancelled = false
  const run = () => {
    if (cancelled || document.visibilityState === 'hidden') return
    void checkForAppUpdate().then(({ updateAvailable }) => {
      if (cancelled) return
      if (updateAvailable) onUpdate()
      else onClear?.()
    })
  }

  run()
  const timer = window.setInterval(run, POLL_MS)
  const onVisible = () => {
    if (document.visibilityState === 'visible') run()
  }
  window.addEventListener('focus', run)
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    cancelled = true
    window.clearInterval(timer)
    window.removeEventListener('focus', run)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
