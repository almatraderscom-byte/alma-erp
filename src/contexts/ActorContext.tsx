'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import {
  normalizeAlmaRole,
  roleHomePath as computeRoleHomePath,
  isPathAllowedForRole,
  type AlmaRole,
} from '@/lib/roles'

interface ActorContextValue {
  actorName: string
  role: AlmaRole
  userId: string
  /** @deprecated Identity is tied to login; use Session for account changes */
  setActorSession: (name: string, role: AlmaRole) => void
}

const ActorContext = createContext<ActorContextValue | null>(null)

export function ActorProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession()
  const { businessId } = useBusiness()
  const pathname = usePathname()
  const router = useRouter()

  const role = normalizeAlmaRole(session?.user?.role)
  const actorName = session?.user?.name || session?.user?.email || 'User'
  const userId = session?.user?.id || ''

  useEffect(() => {
    if (status !== 'authenticated') return
    if (pathname.startsWith('/login')) return
    if (!isPathAllowedForRole(pathname, role, businessId)) {
      router.replace(computeRoleHomePath(role, businessId))
    }
  }, [status, pathname, role, businessId, router])

  const setActorSession = useCallback(() => {
    /* no-op — real accounts change via /settings/users */
  }, [])

  const value = useMemo(
    () => ({ actorName, role, userId, setActorSession }),
    [actorName, role, userId, setActorSession],
  )

  return <ActorContext.Provider value={value}>{children}</ActorContext.Provider>
}

export function useActor() {
  const ctx = useContext(ActorContext)
  if (!ctx) throw new Error('useActor must be used within ActorProvider')
  return ctx
}
