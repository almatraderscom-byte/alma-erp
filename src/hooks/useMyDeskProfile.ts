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
  const sessionStatusRef = useRef(sessionStatus)
  const sessionEmployeeIdRef = useRef(sessionEmployeeId)
  const syncScopeRef = useRef('')
  const sessionSyncAttemptedRef = useRef(false)
  const sessionUpdateInFlightRef = useRef(false)
  const updateSessionRef = useRef(updateSession)

  sessionUserRef.current = session?.user
  sessionStatusRef.current = sessionStatus
  sessionEmployeeIdRef.current = sessionEmployeeId

  useEffect(() => {
    updateSessionRef.current = updateSession
  }, [updateSession])

  useEffect(() => {
    const scope = `${businessId}:${sessionUserId || ''}`
    if (syncScopeRef.current === scope) return
    syncScopeRef.current = scope
    sessionSyncAttemptedRef.current = false
  }, [businessId, sessionUserId])

  const load = useCallback(async (silent = false) => {
    if (sessionStatusRef.current === 'loading') {
      if (!silent) setLoading(true)
      return
    }
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
      const sessionEmp = String(sessionEmployeeIdRef.current || '').trim()
      if (
        sessionUser
        && resolvedEmp
        && resolvedEmp !== sessionEmp
        && !sessionSyncAttemptedRef.current
        && !sessionUpdateInFlightRef.current
      ) {
        sessionSyncAttemptedRef.current = true
        sessionUpdateInFlightRef.current = true
        try {
          await updateSessionRef.current({
            user: { ...sessionUser, employeeIdGas: resolvedEmp },
          })
          sessionEmployeeIdRef.current = resolvedEmp
        } catch {
          sessionSyncAttemptedRef.current = false
        } finally {
          sessionUpdateInFlightRef.current = false
        }
      }
    } catch (e) {
      if (id !== requestId.current) return
      setError((e as Error).message)
      setProfile(null)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [businessId, sessionUserId])

  useEffect(() => {
    if (sessionStatus === 'loading') {
      const timer = window.setTimeout(() => {
        if (sessionStatusRef.current === 'loading') {
          setLoading(false)
          setError('সেশন লোড হতে দেরি হচ্ছে — পেজ রিফ্রেশ করুন বা আবার লগইন করুন')
        }
      }, 12_000)
      return () => window.clearTimeout(timer)
    }
    void load()
  }, [sessionStatus, load])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const refetch = useCallback(() => load(false), [load])

  const employeeId =
    profile?.employeeIdGas?.trim()
    || sessionEmployeeIdRef.current?.trim()
    || sessionEmployeeId?.trim()
    || null

  return useMemo(
    () => ({
      profile,
      loading: loading || (sessionStatus === 'loading' && profile === null),
      error,
      employeeId,
      refetch,
    }),
    [profile, loading, sessionStatus, error, employeeId, refetch],
  )
}
