'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useBusiness } from '@/contexts/BusinessContext'
import {
  normalizeAlmaRole,
  roleHomePath as computeRoleHomePath,
  isPathAllowedForRole,
  type AlmaRole,
} from '@/lib/roles'

const STORAGE_NAME = 'alma-actor-name'
const STORAGE_ROLE = 'alma-actor-role'

interface ActorContextValue {
  actorName: string
  role: AlmaRole
  setActorSession: (name: string, role: AlmaRole) => void
}

const ActorContext = createContext<ActorContextValue | null>(null)

export function ActorProvider({ children }: { children: ReactNode }) {
  const [actorName, setActorName] = useState('Operator')
  const [role, setRole] = useState<AlmaRole>('SUPER_ADMIN')
  const [hydrated, setHydrated] = useState(false)
  const { businessId } = useBusiness()
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    try {
      setActorName(sessionStorage.getItem(STORAGE_NAME)?.trim() || 'Operator')
      setRole(normalizeAlmaRole(sessionStorage.getItem(STORAGE_ROLE)))
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])

  const setActorSession = useCallback((name: string, r: AlmaRole) => {
    const nm = name.trim().slice(0, 120) || 'Operator'
    const rl = normalizeAlmaRole(r)
    setActorName(nm)
    setRole(rl)
    try {
      sessionStorage.setItem(STORAGE_NAME, nm)
      sessionStorage.setItem(STORAGE_ROLE, rl)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (!isPathAllowedForRole(pathname, role, businessId)) {
      router.replace(computeRoleHomePath(role, businessId))
    }
  }, [hydrated, pathname, role, businessId, router])

  const value = useMemo(
    () => ({ actorName, role, setActorSession }),
    [actorName, role, setActorSession],
  )

  return <ActorContext.Provider value={value}>{children}</ActorContext.Provider>
}

export function useActor() {
  const ctx = useContext(ActorContext)
  if (!ctx) throw new Error('useActor must be used within ActorProvider')
  return ctx
}
