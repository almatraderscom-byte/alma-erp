'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function dispatchAuthFailure() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('alma:auth-failure'))
}

export function useMyDeskProfile(businessId: string) {
  const { data: session, status: sessionStatus, update: updateSession } = useSession()
  const sessionUserId = session?.user?.id
  const sessionEmployeeId = session?.user?.employeeIdGas
  const [profile, setProfile] = useState<DeskProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const sessionUserRef = useRef(session?.user)
  const hasUpdatedSessionRef = useRef(false)
  const updateSessionRef = useRef(updateSession)

  sessionUserRef.current = session?.user

  useEffect(() => {
    updateSessionRef.current = updateSession
  }, [updateSession])

  const load = useCallback(async (silent = false) => {
    if (sessionStatus === 'loading') return
    if (!sessionUserId) {
      setProfile(null)
      setLoading(false)
      setError('Not signed in')
      return
    }

    const id = ++requestId.current
    if (!silent) setLoading(prev => (prev ? prev : true))

    try {
      const result = await safeFetchJson<{ user: DeskProfile }>(
        `/api/users/me?business_id=${encodeURIComponent(businessId)}`,
        { cache: 'no-store', credentials: 'same-origin' },
      )
      if (!result.ok) {
        if (result.status === 401) {
          dispatchAuthFailure()
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

      const sessionUser = sessionUserRef.current
      const resolvedEmp = String((j.user as DeskProfile)?.employeeIdGas || '').trim()
      const sessionEmp = String(sessionEmployeeId || '').trim()
      if (
        sessionUser
        && resolvedEmp
        && resolvedEmp !== sessionEmp
        && !hasUpdatedSessionRef.current
      ) {
        hasUpdatedSessionRef.current = true
        await updateSessionRef.current({
          user: { ...sessionUser, employeeIdGas: resolvedEmp },
        })
      }
    } catch (e) {
      if (id !== requestId.current) return
      setError((e as Error).message)
      setProfile(null)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [businessId, sessionUserId, sessionEmployeeId, sessionStatus])

  useEffect(() => {
    hasUpdatedSessionRef.current = false
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

  const refetch = useCallback(() => load(false), [load])

  const employeeId = profile?.employeeIdGas?.trim() || sessionEmployeeId?.trim() || null

  return useMemo(
    () => ({
      profile,
      loading: loading || sessionStatus === 'loading',
      error,
      employeeId,
      refetch,
    }),
    [profile, loading, sessionStatus, error, employeeId, refetch],
  )
}
