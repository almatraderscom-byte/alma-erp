'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { safeFetchJson } from '@/lib/safe-fetch'

const MIN_LOAD_GAP_MS = 5_000

function dispatchAuthFailure() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('alma:auth-failure'))
}

export function useMyProfileImage() {
  const { data: session, status: sessionStatus } = useSession()
  const sessionUserId = session?.user?.id
  const { business } = useBusiness()
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const lastLoadAtRef = useRef(0)
  const pausedRef = useRef(false)

  const load = useCallback(async (force = false) => {
    if (sessionStatus !== 'authenticated') return
    if (pausedRef.current) return
    if (!sessionUserId) {
      setProfileImageUrl(null)
      setLoading(false)
      return
    }

    const now = Date.now()
    if (!force && now - lastLoadAtRef.current < MIN_LOAD_GAP_MS) return
    lastLoadAtRef.current = now

    setLoading(true)
    try {
      const result = await safeFetchJson<{ user?: { profileImageUrl?: string | null } }>(
        `/api/users/me?business_id=${business.id}`,
        { cache: 'no-store' },
      )
      if (result.status === 401) {
        pausedRef.current = true
        dispatchAuthFailure()
        return
      }
      if (result.ok) setProfileImageUrl(result.data.user?.profileImageUrl ?? null)
    } finally {
      setLoading(false)
    }
  }, [business.id, sessionUserId, sessionStatus])

  useEffect(() => {
    pausedRef.current = false
    lastLoadAtRef.current = 0
    void load(true)
  }, [load])

  useEffect(() => {
    function onUpdated(event: Event) {
      const detail = (event as CustomEvent<{
        userId?: string
        profileImageUrl?: string | null
        updatedAt?: string
      }>).detail
      if (detail?.userId && detail.userId !== sessionUserId) return
      if (detail?.profileImageUrl !== undefined) {
        setProfileImageUrl(detail.profileImageUrl || null)
      }
      void load(true)
    }
    window.addEventListener('alma:profile-updated', onUpdated)
    return () => window.removeEventListener('alma:profile-updated', onUpdated)
  }, [load, sessionUserId])

  return {
    userId: sessionUserId ?? null,
    name: session?.user?.name ?? null,
    email: session?.user?.email ?? null,
    profileImageUrl,
    loading,
    refresh: () => load(true),
  }
}
