'use client'

import { useEffect, useState } from 'react'
import { clearAppCaches, checkForAppUpdate, hardRefreshApp } from '@/lib/app-update'
import { isAuthPath } from '@/lib/auth-paths'
import { isCapacitorNative } from '@/lib/capacitor-native'

const RECOVERY_COOLDOWN_MS = 15_000
const RECOVERY_STORAGE_KEY = 'alma_boot_recovery_at'
const RECOVERY_COUNT_KEY = 'alma_boot_recovery_count'
const MAX_AUTO_RECOVERIES = 2

function shouldRecoverFromMessage(message: string): boolean {
  return /chunk|loading chunk|failed to fetch dynamically imported module|importing a module script failed|loading css chunk/i.test(message)
}

function markAppReady() {
  document.documentElement.dataset.appReady = '1'
  try {
    sessionStorage.removeItem(RECOVERY_COUNT_KEY)
  } catch {
    /* ignore */
  }
}

async function recoverApp(reason: string): Promise<boolean> {
  if (typeof window === 'undefined') return false
  try {
    const count = Number(sessionStorage.getItem(RECOVERY_COUNT_KEY) || 0)
    if (count >= MAX_AUTO_RECOVERIES) {
      console.warn('[alma] boot recovery skipped (max):', reason)
      markAppReady()
      return false
    }
    const last = Number(sessionStorage.getItem(RECOVERY_STORAGE_KEY) || 0)
    if (last && Date.now() - last < RECOVERY_COOLDOWN_MS) return false
    sessionStorage.setItem(RECOVERY_COUNT_KEY, String(count + 1))
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, String(Date.now()))
    console.warn('[alma] boot recovery:', reason)
    await clearAppCaches()
  } catch {
    // still reload
  }
  window.location.reload()
  return true
}

function pageLooksBlank(): boolean {
  if (document.documentElement.dataset.appReady === '1') return false
  if (document.querySelector('main')) return false
  if (document.querySelector('[data-auth-gate]')) return false
  if (document.querySelector('#login-form, [data-login-form]')) return false
  const path = window.location.pathname
  if (isAuthPath(path)) {
    // Login shell should render without <main>
    const bodyKids = document.body?.children?.length ?? 0
    return bodyKids <= 2
  }
  return true
}

/** Auto-heal stale PWA bundles — capped to avoid infinite reload loops. */
export function AppBootRecovery() {
  const [showFallback, setShowFallback] = useState(false)

  useEffect(() => {
    function onError(event: ErrorEvent) {
      const msg = String(event.message || '')
      if (shouldRecoverFromMessage(msg)) void recoverApp('chunk-error')
    }

    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason as { message?: string } | string | undefined
      const msg = typeof reason === 'string' ? reason : String(reason?.message || '')
      if (shouldRecoverFromMessage(msg)) void recoverApp('chunk-rejection')
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    const watchdogMs = isCapacitorNative() ? 12_000 : 18_000
    const watchdog = window.setTimeout(() => {
      if (!pageLooksBlank()) return
      void recoverApp('blank-watchdog').then(reloaded => {
        if (!reloaded) setShowFallback(true)
      })
    }, watchdogMs)

    if (isCapacitorNative()) {
      void checkForAppUpdate().then(({ updateAvailable }) => {
        if (updateAvailable) void hardRefreshApp()
      })
    }

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.clearTimeout(watchdog)
    }
  }, [])

  if (!showFallback) return null

  return (
    <div className="fixed inset-0 z-[100000] flex flex-col items-center justify-center gap-4 bg-transparent px-6 text-center">
      <p className="text-sm font-semibold text-cream">অ্যাপ লোড হচ্ছে না</p>
      <p className="max-w-sm text-xs text-muted">
        ক্যাশ পরিষ্কার করে আবার চেষ্টা করুন। বারবার সমস্যা হলে browser বন্ধ করে আবার খুলুন।
      </p>
      <button
        type="button"
        className="rounded-xl border border-gold/30 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold"
        onClick={() => {
          void clearAppCaches().finally(() => {
            try {
              sessionStorage.removeItem(RECOVERY_COUNT_KEY)
              sessionStorage.removeItem(RECOVERY_STORAGE_KEY)
            } catch {
              /* ignore */
            }
            window.location.href = '/login'
          })
        }}
      >
        ক্যাশ মুছে রিফ্রেশ
      </button>
    </div>
  )
}

export function AppReadyMarker() {
  useEffect(() => {
    markAppReady()
  }, [])
  return null
}
