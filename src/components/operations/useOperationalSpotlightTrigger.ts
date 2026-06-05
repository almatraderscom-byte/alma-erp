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

const PORTAL_POLL_MS = 60_000

type SpotlightTaskMeta = OperationalTaskAssignmentDto['task'] & { showOnCheckIn?: boolean }

type TriggerOptions = {
  /** When true, portal mount/focus/poll may auto-open unseen spotlights */
  hasCheckedInToday?: boolean
  /** HR employee id — auto spotlight/dock disabled when unset */
  employeeIdGas?: string | null
}

async function fetchOpenTasks(businessId: string): Promise<OperationalTaskAssignmentDto[]> {
  const result = await safeFetchJson<{ tasks?: OperationalTaskAssignmentDto[] }>(
    `/api/operational-tasks/my?business_id=${encodeURIComponent(businessId)}`,
    { cache: 'no-store' },
  )
  if (!result.ok) return []
  return result.data.tasks || []
}

function wasSpotlightShownToday(lastSpotlightAt: string | null): boolean {
  if (!lastSpotlightAt) return false
  const shown = new Date(lastSpotlightAt)
  const now = new Date()
  return (
    shown.getFullYear() === now.getFullYear()
    && shown.getMonth() === now.getMonth()
    && shown.getDate() === now.getDate()
  )
}

function isUnseenSpotlightEligible(assignment: OperationalTaskAssignmentDto): boolean {
  if (!isOpsHeroEligible(assignment.status)) return false
  const task = assignment.task as SpotlightTaskMeta
  if (task.showOnCheckIn === false) return false
  if (wasSpotlightShownToday(assignment.lastSpotlightAt)) return false
  return true
}

function pickUnseenSpotlightTask(
  list: OperationalTaskAssignmentDto[],
): OperationalTaskAssignmentDto | null {
  const eligible = list.filter(isUnseenSpotlightEligible)
  return pickPrimaryOpsTask(eligible)
}

async function markSpotlightShownApi(assignmentId: string) {
  await safeFetchJson('/api/operational-tasks/spotlight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignment_id: assignmentId }),
  })
}

export function useOperationalSpotlightTrigger(
  businessId: string,
  enabled = true,
  options: TriggerOptions = {},
) {
  const pathname = usePathname()
  const onPortal = pathname === '/portal'
  const { hasCheckedInToday = false, employeeIdGas = null } = options
  const empLinked = Boolean(String(employeeIdGas || '').trim())
  const spotlightEnabled = enabled && empLinked

  const { tasks, loading, refetch } = useOperationalTasks(businessId, spotlightEnabled)
  const [spotlight, setSpotlight] = useState<OperationalTaskAssignmentDto | null>(null)
  const [heroOpen, setHeroOpen] = useState(false)
  const spotlightIdRef = useRef<string | null>(null)
  const heroOpenRef = useRef(false)
  const portalAutoOpenDoneRef = useRef(false)

  const openTasks = tasks.filter(t => isOpsHeroEligible(t.status))
  const primaryTask = pickPrimaryOpsTask(tasks)

  useEffect(() => {
    heroOpenRef.current = heroOpen
  }, [heroOpen])

  useEffect(() => {
    spotlightIdRef.current = spotlight?.id ?? null
  }, [spotlight?.id])

  useEffect(() => {
    if (!spotlightEnabled || loading) return
    const primary = pickPrimaryOpsTask(tasks)
    if (!primary) {
      setSpotlight(null)
      if (!heroOpenRef.current) return
      setHeroOpen(false)
      return
    }
    setSpotlight(prev => (prev?.id === primary.id ? prev : primary))
  }, [spotlightEnabled, loading, tasks])

  useEffect(() => {
    portalAutoOpenDoneRef.current = false
  }, [businessId, employeeIdGas])

  useEffect(() => {
    if (empLinked) return
    setSpotlight(null)
    setHeroOpen(false)
  }, [empLinked])

  const openSpotlightForTask = useCallback((primary: OperationalTaskAssignmentDto) => {
    setSpotlight(primary)
    setHeroOpen(true)
  }, [])

  const tryOpenUnseenSpotlight = useCallback(
    async (opts?: { requireCheckedIn?: boolean }) => {
      if (!spotlightEnabled || heroOpenRef.current) return false
      if (opts?.requireCheckedIn && !hasCheckedInToday) return false

      invalidateOperationalTasksCache(businessId)
      const list = await fetchOpenTasks(businessId)
      const primary = pickUnseenSpotlightTask(list)
      if (!primary) return false

      openSpotlightForTask(primary)
      void refetch(true)
      return true
    },
    [businessId, spotlightEnabled, hasCheckedInToday, openSpotlightForTask, refetch],
  )

  const minimizeHero = useCallback(async () => {
    const id = spotlightIdRef.current
    setHeroOpen(false)
    if (id) {
      await markSpotlightShownApi(id)
      invalidateOperationalTasksCache(businessId)
    }
  }, [businessId])

  const openHero = useCallback(
    (assignment?: OperationalTaskAssignmentDto) => {
      const target = assignment ?? pickPrimaryOpsTask(tasks)
      if (!target) return
      openSpotlightForTask(target)
    },
    [openSpotlightForTask, tasks],
  )

  const triggerAfterCheckIn = useCallback(async () => {
    if (!spotlightEnabled) return
    invalidateOperationalTasksCache(businessId)
    await refetch(true)
    const list = await fetchOpenTasks(businessId)
    const primary = pickUnseenSpotlightTask(list)
    if (!primary) {
      setHeroOpen(false)
      return
    }
    openSpotlightForTask(primary)
  }, [businessId, spotlightEnabled, openSpotlightForTask, refetch])

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

  useEffect(() => {
    if (!spotlightEnabled || !onPortal || loading || portalAutoOpenDoneRef.current) return
    portalAutoOpenDoneRef.current = true
    void tryOpenUnseenSpotlight({ requireCheckedIn: true })
  }, [spotlightEnabled, onPortal, loading, hasCheckedInToday, tryOpenUnseenSpotlight])

  useEffect(() => {
    if (!spotlightEnabled || !onPortal) return

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || heroOpenRef.current) return
      void tryOpenUnseenSpotlight({ requireCheckedIn: true })
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [spotlightEnabled, onPortal, hasCheckedInToday, tryOpenUnseenSpotlight])

  useEffect(() => {
    if (!spotlightEnabled || !onPortal) return

    const timer = window.setInterval(() => {
      if (heroOpenRef.current || document.visibilityState !== 'visible') return
      void tryOpenUnseenSpotlight({ requireCheckedIn: true })
    }, PORTAL_POLL_MS)

    return () => window.clearInterval(timer)
  }, [spotlightEnabled, onPortal, hasCheckedInToday, tryOpenUnseenSpotlight])

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
