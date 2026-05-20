'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'

export function useMyProfileImage() {
  const { data: session } = useSession()
  const { business } = useBusiness()
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!session?.user?.id) {
      setProfileImageUrl(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/users/me?business_id=${business.id}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (res.ok) setProfileImageUrl((j.user as { profileImageUrl?: string | null })?.profileImageUrl ?? null)
    } finally {
      setLoading(false)
    }
  }, [business.id, session?.user?.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    function onUpdated(event: Event) {
      const detail = (event as CustomEvent<{
        userId?: string
        profileImageUrl?: string | null
        updatedAt?: string
      }>).detail
      if (detail?.userId && detail.userId !== session?.user?.id) return
      if (detail?.profileImageUrl !== undefined) {
        setProfileImageUrl(detail.profileImageUrl || null)
      }
      void load()
    }
    window.addEventListener('alma:profile-updated', onUpdated)
    return () => window.removeEventListener('alma:profile-updated', onUpdated)
  }, [load, session?.user?.id])

  return {
    userId: session?.user?.id ?? null,
    name: session?.user?.name ?? null,
    email: session?.user?.email ?? null,
    profileImageUrl,
    loading,
    refresh: load,
  }
}
