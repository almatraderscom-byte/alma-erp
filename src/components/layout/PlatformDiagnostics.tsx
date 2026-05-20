'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { logPlatformDiagnostic } from '@/lib/platform-diagnostics'

/**
 * Lightweight production-safe shell diagnostics (no user-visible UI).
 */
export function PlatformDiagnostics() {
  const pathname = usePathname() ?? ''
  const mountedRef = useRef(false)

  useEffect(() => {
    logPlatformDiagnostic('platform.shell.mounted', { pathname })
    mountedRef.current = true

    const checkWatermark = () => {
      const el = document.querySelector('[data-platform-watermark="true"]')
      if (!el) {
        logPlatformDiagnostic('platform.watermark.missing', { pathname })
      }
    }

    const t0 = window.setTimeout(checkWatermark, 1200)
    const t1 = window.setTimeout(checkWatermark, 5000)

    return () => {
      window.clearTimeout(t0)
      window.clearTimeout(t1)
    }
  }, [pathname])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    const onError = (event: ErrorEvent) => {
      const msg = String(event.message || '')
      if (msg.toLowerCase().includes('hydration')) {
        logPlatformDiagnostic('platform.shell.hydration_mismatch', {
          pathname,
          message: msg.slice(0, 200),
        })
      }
    }
    window.addEventListener('error', onError)
    return () => window.removeEventListener('error', onError)
  }, [pathname])

  return null
}
