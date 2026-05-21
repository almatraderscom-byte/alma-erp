'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { safeFetchJson, safeFetchJsonOrThrow } from '@/lib/safe-fetch'

export type OperationalTaskAssignmentDto = {
  id: string
  taskId: string
  userId: string
  status: string
  lastSpotlightAt: string | null
  task: {
    id: string
    title: string
    description: string
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
    bannerImageUrl: string | null
    deadline: string | null
    acknowledgmentRequired: boolean
    allowDismiss: boolean
    assignedBy: { id: string; name: string }
  }
}

const CACHE_MS = 60_000

function cacheKey(businessId: string) {
  return `alma-ops-tasks:${businessId}`
}

function readCache(businessId: string): OperationalTaskAssignmentDto[] | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(businessId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at: number; tasks: OperationalTaskAssignmentDto[] }
    if (Date.now() - parsed.at > CACHE_MS) return null
    return parsed.tasks
  } catch {
    return null
  }
}

function writeCache(businessId: string, tasks: OperationalTaskAssignmentDto[]) {
  try {
    sessionStorage.setItem(cacheKey(businessId), JSON.stringify({ at: Date.now(), tasks }))
  } catch {
    /* ignore */
  }
}

export function invalidateOperationalTasksCache(businessId: string) {
  try {
    sessionStorage.removeItem(cacheKey(businessId))
    sessionStorage.removeItem(`alma-spotlight-shown:${businessId}`)
  } catch {
    /* ignore */
  }
}

export function spotlightSessionKey(assignmentId: string) {
  return `alma-spotlight-once:${assignmentId}`
}

export function wasSpotlightShownThisSession(assignmentId: string): boolean {
  try {
    return sessionStorage.getItem(spotlightSessionKey(assignmentId)) === '1'
  } catch {
    return false
  }
}

export function markSpotlightShownSession(assignmentId: string) {
  try {
    sessionStorage.setItem(spotlightSessionKey(assignmentId), '1')
  } catch {
    /* ignore */
  }
}

export function useOperationalTasks(businessId: string, enabled = true) {
  const [tasks, setTasks] = useState<OperationalTaskAssignmentDto[]>(() =>
    enabled ? readCache(businessId) || [] : [],
  )
  const [loading, setLoading] = useState(enabled && !readCache(businessId))
  const mounted = useRef(true)

  const refetch = useCallback(async (force = false) => {
    if (!enabled) return
    if (!force) {
      const cached = readCache(businessId)
      if (cached) {
        setTasks(cached)
        setLoading(false)
        return
      }
    }
    setLoading(true)
    try {
      const result = await safeFetchJson<{ tasks?: OperationalTaskAssignmentDto[] }>(
        `/api/operational-tasks/my?business_id=${encodeURIComponent(businessId)}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      const list = result.data.tasks || []
      if (mounted.current) {
        setTasks(list)
        writeCache(businessId, list)
      }
    } catch {
      if (mounted.current) setTasks([])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [businessId, enabled])

  useEffect(() => {
    mounted.current = true
    void refetch()
    return () => {
      mounted.current = false
    }
  }, [refetch])

  return { tasks, loading, refetch }
}

export async function fetchSpotlightAssignment(businessId: string) {
  const result = await safeFetchJson<{ assignment?: OperationalTaskAssignmentDto | null }>(
    `/api/operational-tasks/spotlight?business_id=${encodeURIComponent(businessId)}`,
    { cache: 'no-store' },
  )
  if (!result.ok) return null
  return result.data.assignment || null
}

export async function patchAssignmentAction(
  assignmentId: string,
  action: 'acknowledge' | 'start' | 'complete' | 'dismiss',
) {
  const data = await safeFetchJsonOrThrow<{ assignment: OperationalTaskAssignmentDto }>(
    `/api/operational-tasks/assignments/${assignmentId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  )
  return data.assignment
}
