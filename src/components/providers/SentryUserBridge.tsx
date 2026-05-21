'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { setSentryUser } from '@/lib/sentry/capture'

/** Attach session + business context to Sentry (no PII beyond user id/email). */
export function SentryUserBridge() {
  const { data: session, status } = useSession()
  const { businessId } = useBusiness()

  useEffect(() => {
    if (status === 'loading') return
    const user = session?.user
    if (!user?.id) {
      setSentryUser(null)
      return
    }
    setSentryUser({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      businessAccess: user.businessAccess,
    })
  }, [session, status])

  useEffect(() => {
    if (status !== 'authenticated') return
    void import('@sentry/nextjs').then(Sentry => {
      Sentry.setTag('business.id', businessId)
    })
  }, [businessId, status])

  return null
}
