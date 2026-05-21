'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  invalidateOperationalTasksCache,
  useOperationalTasks,
  type OperationalTaskAssignmentDto,
} from '@/hooks/useOperationalTasks'
import {
  isOpsHeroEligible,
  pickPrimaryOpsTask,
} from '@/lib/operational-task-spotlight-client'
import { safeFetchJson } from '@/lib/safe-fetch'

async function fetchOpenTasks(businessId: string): Promise<OperationalTaskAssignmentDto[]> {
  const result = await safeFetchJson<{ tasks?: OperationalTaskAssignmentDto[] }>(
    `/api/operational-tasks/my?business_id=${encodeURIComponent(businessId)}`,
    { cache: 'no-store' },
  )
  if (!result.ok) return []
  return result.data.tasks || []
}

export function useOperationalSpotlightTrigger(businessId: string, enabled = true) {
  const pathname = usePathname()
  const { tasks, loading, refetch } = useOperationalTasks(businessId, enabled)
  const [spotlight, setSpotlight] = useState<OperationalTaskAssignmentDto | null>(null)
  const [heroOpen, setHeroOpen] = useState(false)
  const [deskVisit, setDeskVisit] = useState(0)
  const prevPathRef = useRef<string | null>(null)

  const openTasks = tasks.filter(t => isOpsHeroEligible(t.status))
  const primaryTask = pickPrimaryOpsTask(tasks)

  useEffect(() => {
    if (!enabled) return
    if (pathname === '/portal' && prevPathRef.current !== '/portal') {
      setDeskVisit(v => v + 1)
    }
    prevPathRef.current = pathname
  }, [pathname, enabled])

  useEffect(() => {
    if (!enabled || loading || pathname !== '/portal') return
    const primary = pickPrimaryOpsTask(tasks)
    if (!primary) {
      setSpotlight(null)
      setHeroOpen(false)
      return
    }
    setSpotlight(primary)
  }, [enabled, loading, pathname, tasks])

  useEffect(() => {
    if (!enabled || loading || pathname !== '/portal') return
    if (!pickPrimaryOpsTask(tasks)) return
    setHeroOpen(true)
  }, [deskVisit, enabled, loading, pathname])

  const minimizeHero = useCallback(() => {
    setHeroOpen(false)
  }, [])

  const openHero = useCallback(
    (assignment?: OperationalTaskAssignmentDto) => {
      const target = assignment ?? pickPrimaryOpsTask(tasks)
      if (!target) return
      setSpotlight(target)
      setHeroOpen(true)
    },
    [tasks],
  )

  const triggerAfterCheckIn = useCallback(async () => {
    if (!enabled) return
    invalidateOperationalTasksCache(businessId)
    await refetch(true)
    const list = await fetchOpenTasks(businessId)
    const primary = pickPrimaryOpsTask(list)
    if (!primary) return
    setSpotlight(primary)
    setHeroOpen(true)
  }, [businessId, enabled, refetch])

  const handleUpdated = useCallback(async () => {
    invalidateOperationalTasksCache(businessId)
    await refetch(true)
    const list = await fetchOpenTasks(businessId)
    const primary = pickPrimaryOpsTask(list)
    if (!primary) {
      setSpotlight(null)
      setHeroOpen(false)
      return
    }
    setSpotlight(primary)
    setHeroOpen(false)
  }, [businessId, refetch])

  return {
    tasks: openTasks,
    allTasks: tasks,
    loading,
    refetch,
    spotlight,
    heroOpen,
    primaryTask,
    openTasks,
    minimizeHero,
    openHero,
    triggerAfterCheckIn,
    handleUpdated,
    openManual: openHero,
  }
}
