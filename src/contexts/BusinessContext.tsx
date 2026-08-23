'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
  resolveEntityRouteBusiness,
  resolveBusinessId,
} from '@/lib/businesses'
import { setApiBusinessId } from '@/lib/api'
import { parseBusinessAccess } from '@/lib/business-access'

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

function routeBusinessSelector(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('business_id')
}

function routeHasExactEntityFocus(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(new URLSearchParams(window.location.search).get('focus')?.trim())
}

function effectiveBusinessId(pathname: string, allowedBusinessIds: readonly BusinessId[]): BusinessId {
  const stored = loadBusinessId()
  const allowedStored = allowedBusinessIds.includes(stored)
    ? stored
    : (allowedBusinessIds[0] ?? DEFAULT_BUSINESS_ID)
  const entityRoute = resolveEntityRouteBusiness(
    pathname,
    routeBusinessSelector(),
    allowedStored,
    allowedBusinessIds,
    { hasExactEntityFocus: routeHasExactEntityFocus() },
  )
  if (entityRoute.kind === 'authorized') return entityRoute.businessId
  if (pathname.startsWith('/trading') && allowedBusinessIds.includes('ALMA_TRADING')) return 'ALMA_TRADING'
  if (pathname.startsWith('/digital') && allowedBusinessIds.includes('CREATIVE_DIGITAL_IT')) return 'CREATIVE_DIGITAL_IT'
  return allowedStored
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
  const allowedBusinessIds = useMemo(
    () => parseBusinessAccess(allowedBusinessAccess ?? undefined),
    [allowedBusinessAccess],
  )
  const [businessId, setBusinessIdState] = useState<BusinessId>(
    () => effectiveBusinessId(pathname, allowedBusinessIds),
  )
  const [hydrated, setHydrated] = useState(() => typeof window !== 'undefined')

  useLayoutEffect(() => {
    const next = effectiveBusinessId(pathname, allowedBusinessIds)
    setBusinessIdState(next)
    setApiBusinessId(next)
    try {
      sessionStorage.setItem(STORAGE_KEY, next)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [allowedBusinessIds, pathname])

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
    const entityRoute = resolveEntityRouteBusiness(
      pathname,
      routeBusinessSelector(),
      businessId,
      allowedBusinessIds,
      { hasExactEntityFocus: routeHasExactEntityFocus() },
    )
    if (entityRoute.kind === 'invalid' || entityRoute.kind === 'forbidden') {
      router.replace(BUSINESSES[businessId].homePath)
      return
    }
    if (!isRouteAllowed(pathname, businessId)) {
      router.replace(BUSINESSES[businessId].homePath)
    }
  }, [hydrated, pathname, businessId, allowedBusinessIds, router])

  const business = BUSINESSES[businessId]

  const value = useMemo(
    () => ({ businessId, business, allowedBusinessIds, setBusinessId }),
    [businessId, business, allowedBusinessIds, setBusinessId],
  )

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
