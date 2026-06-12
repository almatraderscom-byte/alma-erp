'use client'

import { useEffect } from 'react'
import { clearStaleRuntimeCaches } from '@/components/providers/PwaBootstrap'

const RECOVERY_COOLDOWN_MS = 12_000
const RECOVERY_STORAGE_KEY = 'alma_boot_recovery_at'

function shouldRecoverFromMessage(message: string): boolean {
  return /chunk|loading chunk|failed to fetch dynamically imported module|importing a module script failed|loading css chunk/i.test(message)
}

async function recoverApp(reason: string) {
  if (typeof window === 'undefined') return
  try {
    const last = Number(sessionStorage.getItem(RECOVERY_STORAGE_KEY) || 0)
    if (last && Date.now() - last < RECOVERY_COOLDOWN_MS) return
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, String(Date.now()))
    console.warn('[alma] boot recovery:', reason)
    await clearStaleRuntimeCaches()
  } catch {
    // still reload
  }
  window.location.reload()
}

/** Auto-heal stale PWA bundles and blank boots without reinstall. */
export function AppBootRecovery() {
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

    const watchdog = window.setTimeout(() => {
      if (document.documentElement.dataset.appReady === '1') return
      const hasMain = Boolean(document.querySelector('main'))
      const hasAuthUi = Boolean(document.querySelector('[data-auth-gate]'))
      if (!hasMain && !hasAuthUi) void recoverApp('blank-watchdog')
    }, 14_000)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.clearTimeout(watchdog)
    }
  }, [])

  return null
}

export function AppReadyMarker() {
  useEffect(() => {
    document.documentElement.dataset.appReady = '1'
  }, [])
  return null
}
