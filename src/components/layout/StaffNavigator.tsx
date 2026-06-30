'use client'

import dynamic from 'next/dynamic'
import { useSession } from 'next-auth/react'
import { usePathname } from 'next/navigation'

/**
 * ERP-side bridge that mounts the staff navigator assistant app-wide. The actual
 * component lives in src/agent (it reuses the voice stack); we load it via a
 * dynamic import so the ERP shell keeps no static dependency on agent code — the
 * same runtime-bridge pattern used elsewhere (e.g. buildOwnerDailyDigest).
 */
const StaffAssistant = dynamic(() => import('@/agent/components/StaffAssistant'), { ssr: false })

// Hidden where it would clash or doesn't belong: the owner's full agent, login,
// and the full-screen new-order drawer.
const HIDE_PREFIXES = ['/agent', '/login', '/forgot-password', '/reset-password', '/orders/new', '/invoice/share']

export function StaffNavigator() {
  const { status } = useSession()
  const path = usePathname() ?? ''
  if (status !== 'authenticated') return null
  if (HIDE_PREFIXES.some((p) => path.startsWith(p))) return null
  return <StaffAssistant />
}
