'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useSession } from 'next-auth/react'
import toast from 'react-hot-toast'
import { invalidateQueryCache } from '@/hooks/useQuery'
import { isNativeShell } from '@/lib/native-shell'
import {
  mobileRefreshHaptic,
  performMobileRefresh,
  type MobileRefreshResult,
} from '@/lib/mobile-refresh'

type MobileRefreshContextValue = {
  refresh: (opts?: { silent?: boolean; force?: boolean }) => Promise<MobileRefreshResult>
  refreshing: boolean
  lastResult: MobileRefreshResult | null
  registerScrollElement: (el: HTMLElement | null) => void
  scrollElement: HTMLElement | null
  isMobileEnabled: boolean
}

const MobileRefreshContext = createContext<MobileRefreshContextValue | null>(null)

export function useMobileRefresh() {
  const ctx = useContext(MobileRefreshContext)
  if (!ctx) {
    return {
      refresh: async () => ({ ok: false, reason: 'error' as const }),
      refreshing: false,
      lastResult: null,
      registerScrollElement: () => undefined,
      scrollElement: null,
      isMobileEnabled: false,
    }
  }
  return ctx
}

function useMobileRefreshEnabled() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const check = () => {
      // Inside the native iOS shell the app provides its own native pull-to-refresh,
      // so the web gesture is fully disabled there. Non-native web is unaffected.
      if (isNativeShell()) {
        setEnabled(false)
        return
      }
      const narrow = window.matchMedia('(max-width: 767px)').matches
      const touch =
        'ontouchstart' in window
        || navigator.maxTouchPoints > 0
        || window.matchMedia('(pointer: coarse)').matches
      setEnabled(narrow && touch)
    }
    check()
    const mq = window.matchMedia('(max-width: 767px)')
    mq.addEventListener('change', check)
    window.addEventListener('orientationchange', check)
    return () => {
      mq.removeEventListener('change', check)
      window.removeEventListener('orientationchange', check)
    }
  }, [])

  return enabled
}

export function MobileRefreshProvider({ children }: { children: ReactNode }) {
  const { update: updateSession } = useSession()
  const [refreshing, setRefreshing] = useState(false)
  const [lastResult, setLastResult] = useState<MobileRefreshResult | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const isMobileEnabled = useMobileRefreshEnabled()
  const refreshGen = useRef(0)

  const registerScrollElement = useCallback((el: HTMLElement | null) => {
    setScrollElement(el)
  }, [])

  const refresh = useCallback(
    async (opts?: { silent?: boolean; force?: boolean }) => {
      const gen = ++refreshGen.current
      setRefreshing(true)
      try {
        const result = await performMobileRefresh({
          force: opts?.force,
          invalidateCache: () => invalidateQueryCache(),
          sessionUpdate: async () => {
            try {
              await updateSession()
            } catch {
              /* session refresh is best-effort */
            }
          },
        })
        if (gen !== refreshGen.current) return result
        setLastResult(result)
        if (!opts?.silent) {
          if (result.ok) {
            mobileRefreshHaptic('success')
            toast.success('Updated', { id: 'mobile-refresh-ok', duration: 1800 })
          } else if (result.reason === 'offline') {
            mobileRefreshHaptic('error')
            toast.error('Connection lost. Pull again to retry.', { id: 'mobile-refresh-offline' })
          } else if (result.reason === 'error') {
            mobileRefreshHaptic('error')
            toast.error('Could not refresh. Pull again to retry.', { id: 'mobile-refresh-error' })
          }
        }
        return result
      } finally {
        if (gen === refreshGen.current) setRefreshing(false)
      }
    },
    [updateSession],
  )

  useEffect(() => {
    if (!isMobileEnabled) return
    const onOnline = () => {
      void refresh({ silent: true, force: true })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [isMobileEnabled, refresh])

  const value = useMemo(
    () => ({
      refresh,
      refreshing,
      lastResult,
      registerScrollElement,
      scrollElement,
      isMobileEnabled,
    }),
    [refresh, refreshing, lastResult, registerScrollElement, scrollElement, isMobileEnabled],
  )

  return <MobileRefreshContext.Provider value={value}>{children}</MobileRefreshContext.Provider>
}
