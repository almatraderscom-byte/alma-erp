'use client'

import { useEffect } from 'react'
import { registerMobileRefreshHandler } from '@/lib/mobile-refresh'

/**
 * Register page-specific refresh logic (manual fetches, live feeds, etc.)
 * Global pull-to-refresh will await all registered handlers.
 */
export function useRegisterMobileRefresh(handler: (() => void | Promise<void>) | null, enabled = true) {
  useEffect(() => {
    if (!enabled || !handler) return
    return registerMobileRefreshHandler(handler)
  }, [handler, enabled])
}
