'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { safeFetchJson } from '@/lib/safe-fetch'

export type DeskProfile = {
  id: string
  email: string
  name: string
  phone: string | null
  role: string
  businessAccess: string
  employeeIdGas: string | null
  joiningDate: string | null
  salaryHint: string | null
  profileImageUrl: string | null
  isSystemOwner?: boolean
  profile?: {
    source: string
    roleTitle: string | null
    shift: string | null
    status: string
    salary: number | null
  }
}

export function useMyDeskProfile(businessId: string) {
  const { data: session, status: sessionStatus, update: updateSession } = useSession()
  const [profile, setProfile] = useState<DeskProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (silent = false) => {
    if (sessionStatus === 'loading') return
    if (!session?.user?.id) {
      setProfile(null)
      setLoading(false)
      setError('Not signed in')
      return
    }

    const id = ++requestId.current
    if (!silent) setLoading(true)

    try {
      const result = await safeFetchJson<{ user: DeskProfile }>(
        `/api/users/me?business_id=${encodeURIComponent(businessId)}`,
        { cache: 'no-store', credentials: 'same-origin' },
      )
      if (!result.ok) {
        if (result.status === 401) {
          setError('Session expired — refresh the page')
          setProfile(null)
          return
        }
        throw new Error(result.error.message || 'Could not load profile')
      }
      const j = result.data
      if (id !== requestId.current) return
      setProfile(j.user as DeskProfile)
      setError(null)

      const resolvedEmp = String((j.user as DeskProfile)?.employeeIdGas || '').trim()
      const sessionEmp = String(session.user.employeeIdGas || '').trim()
      if (resolvedEmp && resolvedEmp !== sessionEmp) {
        await updateSession({
          user: { ...session.user, employeeIdGas: resolvedEmp },
        })
      }
    } catch (e) {
      if (id !== requestId.current) return
      setError((e as Error).message)
      setProfile(null)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [businessId, session, sessionStatus, updateSession])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  return {
    profile,
    loading: loading || sessionStatus === 'loading',
    error,
    employeeId: profile?.employeeIdGas?.trim() || session?.user?.employeeIdGas?.trim() || null,
    refetch: () => load(false),
  }
}
