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

interface BusinessContextValue {
  businessId: BusinessId
  business: BusinessConfig
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

export function BusinessProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [businessId, setBusinessIdState] = useState<BusinessId>(DEFAULT_BUSINESS_ID)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    const stored = loadBusinessId()
    setBusinessIdState(stored)
    setApiBusinessId(stored)
    setHydrated(true)
  }, [])

  const setBusinessId = useCallback(
    (id: BusinessId) => {
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
    [pathname, router],
  )

  useEffect(() => {
    if (!hydrated) return
    if (!isRouteAllowed(pathname, businessId)) {
      router.replace(BUSINESSES[businessId].homePath)
    }
  }, [hydrated, pathname, businessId, router])

  const business = BUSINESSES[businessId]

  const value = useMemo(
    () => ({ businessId, business, setBusinessId }),
    [businessId, business, setBusinessId],
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
