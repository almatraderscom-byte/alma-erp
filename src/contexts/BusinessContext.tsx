'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  type BusinessId,
  type BusinessConfig,
  BUSINESSES,
  DEFAULT_BUSINESS_ID,
  STORAGE_KEY,
  isRouteAllowed,
  resolveBusinessId,
} from '@/lib/businesses'
import { setApiBusinessId } from '@/lib/api'
import { parseBusinessAccess } from '@/lib/business-access'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'

interface BusinessContextValue {
  businessId: BusinessId
  business: BusinessConfig
  allowedBusinessIds: BusinessId[]
  setBusinessId: (id: BusinessId) => void
}

const BusinessContext = createContext<BusinessContextValue | null>(null)

function loadBusinessId(): BusinessId {
  if (typeof window === 'undefined') return DEFAULT_BUSINESS_ID
  try {
    return resolveBusinessId(sessionStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_BUSINESS_ID
  }
}

export function BusinessProvider({
  children,
  allowedBusinessAccess,
}: {
  children: ReactNode
  /** Comma-separated business ids from authenticated session */
  allowedBusinessAccess?: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [businessId, setBusinessIdState] = useState<BusinessId>(DEFAULT_BUSINESS_ID)
  const [hydrated, setHydrated] = useState(false)
  const [showHydrationOverlay, setShowHydrationOverlay] = useState(false)

  const allowedBusinessIds = useMemo(
    () => parseBusinessAccess(allowedBusinessAccess ?? undefined),
    [allowedBusinessAccess],
  )

  useEffect(() => {
    const stored = loadBusinessId()
    const routeBusiness = pathname.startsWith('/trading') && allowedBusinessIds.includes('ALMA_TRADING')
      ? 'ALMA_TRADING'
      : pathname.startsWith('/digital') && allowedBusinessIds.includes('CREATIVE_DIGITAL_IT')
        ? 'CREATIVE_DIGITAL_IT'
        : null
    const next = routeBusiness ?? (allowedBusinessIds.includes(stored)
      ? stored
      : (allowedBusinessIds[0] ?? DEFAULT_BUSINESS_ID))
    setBusinessIdState(next)
    setApiBusinessId(next)
    try {
      sessionStorage.setItem(STORAGE_KEY, next)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [allowedBusinessIds, pathname])

  useEffect(() => {
    if (hydrated) {
      setShowHydrationOverlay(false)
      return
    }
    const timer = window.setTimeout(() => setShowHydrationOverlay(true), 300)
    return () => window.clearTimeout(timer)
  }, [hydrated])

  const setBusinessId = useCallback(
    (id: BusinessId) => {
      if (!allowedBusinessIds.includes(id)) return
      setBusinessIdState(id)
      setApiBusinessId(id)
      try {
        sessionStorage.setItem(STORAGE_KEY, id)
      } catch { /* ignore */ }

      const home = BUSINESSES[id].homePath
      if (!isRouteAllowed(pathname, id)) {
        router.push(home)
      }
    },
    [pathname, router, allowedBusinessIds],
  )

  useEffect(() => {
    if (!hydrated) return
    if (!isRouteAllowed(pathname, businessId)) {
      router.replace(BUSINESSES[businessId].homePath)
    }
  }, [hydrated, pathname, businessId, router])

  const business = BUSINESSES[businessId]

  const value = useMemo(
    () => ({ businessId, business, allowedBusinessIds, setBusinessId }),
    [businessId, business, allowedBusinessIds, setBusinessId],
  )

  if (!hydrated) {
    if (showHydrationOverlay) {
      return <LoadingOverlay label="Loading workspace" />
    }
    return null
  }

  return (
    <BusinessContext.Provider value={value}>
      {children}
    </BusinessContext.Provider>
  )
}

export function useBusiness() {
  const ctx = useContext(BusinessContext)
  if (!ctx) throw new Error('useBusiness must be used within BusinessProvider')
  return ctx
}
