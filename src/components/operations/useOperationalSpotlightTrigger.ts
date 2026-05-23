'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

type SpotlightTaskMeta = OperationalTaskAssignmentDto['task'] & { showOnCheckIn?: boolean }

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

function isCheckInSpotlightEligible(assignment: OperationalTaskAssignmentDto): boolean {
  if (!isOpsHeroEligible(assignment.status)) return false
  const task = assignment.task as SpotlightTaskMeta
  if (task.showOnCheckIn === false) return false
  if (wasSpotlightShownToday(assignment.lastSpotlightAt)) return false
  return true
}

function pickCheckInSpotlightTask(
  list: OperationalTaskAssignmentDto[],
): OperationalTaskAssignmentDto | null {
  const eligible = list.filter(isCheckInSpotlightEligible)
  return pickPrimaryOpsTask(eligible)
}

async function markSpotlightShownApi(assignmentId: string) {
  await safeFetchJson('/api/operational-tasks/spotlight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignment_id: assignmentId }),
  })
}

export function useOperationalSpotlightTrigger(businessId: string, enabled = true) {
  const { tasks, loading, refetch } = useOperationalTasks(businessId, enabled)
  const [spotlight, setSpotlight] = useState<OperationalTaskAssignmentDto | null>(null)
  const [heroOpen, setHeroOpen] = useState(false)
  const spotlightIdRef = useRef<string | null>(null)

  const openTasks = tasks.filter(t => isOpsHeroEligible(t.status))
  const primaryTask = pickPrimaryOpsTask(tasks)

  useEffect(() => {
    spotlightIdRef.current = spotlight?.id ?? null
  }, [spotlight?.id])

  useEffect(() => {
    if (!enabled || loading) return
    const primary = pickPrimaryOpsTask(tasks)
    if (!primary) {
      setSpotlight(null)
      if (!heroOpen) return
      setHeroOpen(false)
      return
    }
    setSpotlight(primary)
  }, [enabled, loading, tasks, heroOpen])

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
    const primary = pickCheckInSpotlightTask(list)
    if (!primary) {
      setHeroOpen(false)
      return
    }
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
