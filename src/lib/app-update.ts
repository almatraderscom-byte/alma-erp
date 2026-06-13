import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'

export const BUILD_RELOAD_GUARD_KEY = 'alma_build_reload_guard'
const POLL_MS = 90_000

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

export async function fetchRemoteBuildId(): Promise<string | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
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

/** True when server has a newer deploy than what this device last synced. */
export function isUpdateAvailable(storedId: string | null, remoteId: string | null): boolean {
  if (!isMeaningfulBuildId(remoteId)) return false
  const stored = storedId?.trim() || ''
  if (!stored) return false
  return stored !== remoteId
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
  try {
    await clearAppCaches()
    sessionStorage.removeItem(BUILD_RELOAD_GUARD_KEY)
    localStorage.removeItem(RUNTIME_BUILD_STORAGE_KEY)
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

/** Poll /api/health and compare against stored build id. */
export async function checkForAppUpdate(): Promise<{
  remoteId: string | null
  storedId: string | null
  updateAvailable: boolean
}> {
  const remoteId = await fetchRemoteBuildId()
  const storedId = readStoredBuildId()
  const updateAvailable = isUpdateAvailable(storedId, remoteId)
  if (remoteId && !updateAvailable && isMeaningfulBuildId(remoteId)) {
    markBuildSynced(remoteId)
  } else if (
    remoteId
    && isMeaningfulBuildId(remoteId)
    && isMeaningfulBuildId(APP_BUILD_ID)
    && remoteId === APP_BUILD_ID
    && storedId !== remoteId
  ) {
    markBuildSynced(remoteId)
  }
  return { remoteId, storedId, updateAvailable }
}

export function subscribeAppUpdateChecks(onUpdate: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  let cancelled = false
  const run = () => {
    if (cancelled || document.visibilityState === 'hidden') return
    void checkForAppUpdate().then(({ updateAvailable }) => {
      if (!cancelled && updateAvailable) onUpdate()
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
