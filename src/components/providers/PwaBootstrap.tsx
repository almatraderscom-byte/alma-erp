'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'
import { subscribeIosVisualViewport } from '@/lib/ios-modal-viewport'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const INSTALL_DISMISSED_KEY = 'alma_pwa_install_dismissed_at'
const INSTALL_REMINDER_MS = 7 * 24 * 60 * 60 * 1000
const OFFLINE_CONFIRM_DELAY_MS = 8_000
const CRITICAL_FAILURE_THRESHOLD = 3

function isStandaloneDisplay() {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isIosSafari() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iphone|ipad|ipod/i.test(ua) && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua)
}

export async function clearStaleRuntimeCaches() {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map(reg => reg.unregister()))
  }
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(keys.map(key => caches.delete(key)))
  }
}

export function PwaBootstrap() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [showInstall, setShowInstall] = useState(false)
  const [offline, setOffline] = useState(false)
  const [staleBuild, setStaleBuild] = useState(false)
  const ios = useMemo(() => isIosSafari(), [])

  const forceRefresh = useCallback(async () => {
    try {
      await clearStaleRuntimeCaches()
    } catch {
      // reload still attempts to pick up the new bundle
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RUNTIME_BUILD_STORAGE_KEY, APP_BUILD_ID)
    }
    window.location.reload()
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  useEffect(() => {
    function onAuthCacheClear() {
      void clearStaleRuntimeCaches()
    }
    window.addEventListener('alma:auth-failure', onAuthCacheClear)
    window.addEventListener('alma:force-relogin', onAuthCacheClear)
    return () => {
      window.removeEventListener('alma:auth-failure', onAuthCacheClear)
      window.removeEventListener('alma:force-relogin', onAuthCacheClear)
    }
  }, [])

  useEffect(() => subscribeIosVisualViewport(() => {}), [])

  useEffect(() => {
    let offlineTimer: number | null = null
    let criticalFailures = 0

    const clearOfflineTimer = () => {
      if (!offlineTimer) return
      window.clearTimeout(offlineTimer)
      offlineTimer = null
    }
    const recoverOnline = () => {
      criticalFailures = 0
      clearOfflineTimer()
      setOffline(false)
    }
    const scheduleOffline = () => {
      if (offlineTimer || offline) return
      offlineTimer = window.setTimeout(() => {
        offlineTimer = null
        if (navigator.onLine === false || criticalFailures >= CRITICAL_FAILURE_THRESHOLD) {
          setOffline(true)
        }
      }, OFFLINE_CONFIRM_DELAY_MS)
    }
    const handleNativeOffline = () => {
      scheduleOffline()
    }
    const handleNativeOnline = () => {
      recoverOnline()
      window.setTimeout(() => {
        if (navigator.onLine !== false) setOffline(false)
      }, 1_000)
    }
    const handleApiHealth = (event: Event) => {
      const detail = (event as CustomEvent<{ ok: boolean; critical?: boolean }>).detail
      if (detail?.ok) {
        recoverOnline()
        return
      }
      if (!detail?.critical) return
      criticalFailures += 1
      if (criticalFailures >= CRITICAL_FAILURE_THRESHOLD) scheduleOffline()
    }

    if (navigator.onLine === false) scheduleOffline()
    window.addEventListener('online', handleNativeOnline)
    window.addEventListener('offline', handleNativeOffline)
    window.addEventListener('alma:api-health', handleApiHealth)
    return () => {
      clearOfflineTimer()
      window.removeEventListener('online', handleNativeOnline)
      window.removeEventListener('offline', handleNativeOffline)
      window.removeEventListener('alma:api-health', handleApiHealth)
    }
  }, [offline])

  useEffect(() => {
    if (isStandaloneDisplay()) return
    const dismissedAt = Number(localStorage.getItem(INSTALL_DISMISSED_KEY) || 0)
    if (dismissedAt && Date.now() - dismissedAt < INSTALL_REMINDER_MS) return

    const timer = window.setTimeout(() => {
      if (ios) setShowInstall(true)
    }, 1800)

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
      setShowInstall(true)
    }

    function onInstalled() {
      setShowInstall(false)
      setInstallEvent(null)
      localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()))
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [ios])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(RUNTIME_BUILD_STORAGE_KEY)
    if (!stored) {
      localStorage.setItem(RUNTIME_BUILD_STORAGE_KEY, APP_BUILD_ID)
    } else if (stored !== APP_BUILD_ID && APP_BUILD_ID !== 'dev' && APP_BUILD_ID !== 'local') {
      setStaleBuild(true)
    }

    let cancelled = false
    async function pollBuild() {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const json = await res.json().catch(() => ({}))
        const remote = String(json?.frontend?.git_commit || '').trim()
        if (!remote || cancelled) return
        const local = localStorage.getItem(RUNTIME_BUILD_STORAGE_KEY) || APP_BUILD_ID
        if (local && remote !== local && remote !== APP_BUILD_ID) {
          setStaleBuild(true)
        }
      } catch {
        // ignore transient health failures
      }
    }
    void pollBuild()
    const timer = window.setInterval(() => void pollBuild(), 5 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!staleBuild || process.env.NODE_ENV !== 'production') return
    const onChunkError = (event: ErrorEvent) => {
      const msg = String(event.message || '')
      if (/chunk|loading chunk|failed to fetch dynamically imported module/i.test(msg)) {
        void forceRefresh()
      }
    }
    window.addEventListener('error', onChunkError)
    return () => window.removeEventListener('error', onChunkError)
  }, [staleBuild, forceRefresh])

  async function install() {
    if (!installEvent) return
    await installEvent.prompt()
    const choice = await installEvent.userChoice.catch(() => null)
    if (choice?.outcome === 'accepted') {
      setShowInstall(false)
    }
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()))
  }

  function dismissInstall() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()))
    setShowInstall(false)
  }

  return (
    <>
      {staleBuild && (
        <div className="fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-[225] mx-auto max-w-md rounded-2xl border border-gold-dim/45 bg-[#101014]/95 px-4 py-3 text-xs text-cream shadow-2xl shadow-black/40 backdrop-blur-xl">
          <p className="font-black text-gold-lt">App update required</p>
          <p className="mt-1 text-zinc-400">
            Your device is running an older Alma ERP build. Refresh to load the latest version and avoid page errors.
          </p>
          <button
            type="button"
            onClick={() => void forceRefresh()}
            className="mt-2 rounded-xl border border-gold-dim/50 bg-gold/15 px-3 py-2 text-[11px] font-black text-gold-lt active:scale-[0.98]"
          >
            Refresh now
          </button>
        </div>
      )}

      {offline && (
        <div className="fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-[220] mx-auto max-w-md rounded-2xl border border-amber-300/30 bg-[#101014]/95 px-4 py-3 text-xs font-semibold text-amber-100 shadow-2xl shadow-black/40 backdrop-blur-xl">
          Offline mode: live ERP data will refresh when the connection returns.
        </div>
      )}

      {showInstall && (
        <div className="fixed inset-x-3 bottom-[calc(5.8rem+env(safe-area-inset-bottom,0px))] z-[210] mx-auto max-w-md rounded-[26px] border border-gold-dim/40 bg-[#09090d]/95 p-4 text-cream shadow-2xl shadow-black/60 backdrop-blur-2xl md:bottom-5">
          <div className="flex items-start gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-gold-dim/45 bg-gold/10 text-lg font-black text-gold-lt">
              A
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black">Install Alma ERP</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                {ios
                  ? 'For a full-screen app experience, tap Share, then Add to Home Screen.'
                  : 'Add Alma ERP to your home screen for faster launches and app-like navigation.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {installEvent && (
                  <button
                    type="button"
                    onClick={() => void install()}
                    className="rounded-xl border border-gold-dim/50 bg-gold/15 px-3 py-2 text-[11px] font-black text-gold-lt active:scale-[0.98]"
                  >
                    Install app
                  </button>
                )}
                <button
                  type="button"
                  onClick={dismissInstall}
                  className="rounded-xl border border-border bg-white/[0.03] px-3 py-2 text-[11px] font-bold text-zinc-400 active:scale-[0.98]"
                >
                  Later
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
