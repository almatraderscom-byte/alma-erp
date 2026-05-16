'use client'
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { api } from '@/lib/api'
import { useBusiness } from '@/contexts/BusinessContext'
import type { BusinessBranding } from '@/types/branding'
import { defaultBusinessBranding, readCachedBranding, writeCachedBranding } from '@/lib/branding-defaults'

interface BrandingContextValue {
  branding: BusinessBranding | null
  loading: boolean
  error: string | null
  isBrandReady: boolean
  refetch: () => Promise<void>
}

const BrandingContext = createContext<BrandingContextValue | null>(null)

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { businessId } = useBusiness()
  const [branding, setBranding] = useState<BusinessBranding | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    const cached = readCachedBranding(businessId)
    if (cached) setBranding(cached)
    try {
      const data = await api.branding.get(businessId)
      setBranding(data.branding)
      writeCachedBranding(businessId, data.branding)
    } catch (e) {
      setError((e as Error).message)
      setBranding(cached || defaultBusinessBranding(businessId))
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    refetch()
  }, [refetch])

  const value = useMemo(
    () => ({ branding, loading, error, isBrandReady: Boolean(branding), refetch }),
    [branding, loading, error, refetch],
  )

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  )
}

export function useBranding() {
  const ctx = useContext(BrandingContext)
  if (!ctx) throw new Error('useBranding must be used within BrandingProvider')
  return ctx
}
