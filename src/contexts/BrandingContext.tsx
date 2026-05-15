'use client'
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { api } from '@/lib/api'
import { useBusiness } from '@/contexts/BusinessContext'
import type { BusinessBranding } from '@/types/branding'

interface BrandingContextValue {
  branding: BusinessBranding | null
  loading: boolean
  refetch: () => Promise<void>
}

const BrandingContext = createContext<BrandingContextValue | null>(null)

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { businessId } = useBusiness()
  const [branding, setBranding] = useState<BusinessBranding | null>(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.branding.get(businessId)
      setBranding(data.branding)
    } catch {
      setBranding(null)
    } finally {
      setLoading(false)
    }
  }, [businessId])

  useEffect(() => {
    refetch()
  }, [refetch])

  const value = useMemo(
    () => ({ branding, loading, refetch }),
    [branding, loading, refetch],
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
