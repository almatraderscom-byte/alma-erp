'use client'

import { useCallback, useState } from 'react'
import {
  fetchSpotlightAssignment,
  invalidateOperationalTasksCache,
  markSpotlightShownSession,
  useOperationalTasks,
  wasSpotlightShownThisSession,
  type OperationalTaskAssignmentDto,
} from '@/hooks/useOperationalTasks'

export function useOperationalSpotlightTrigger(businessId: string, enabled = true) {
  const [spotlight, setSpotlight] = useState<OperationalTaskAssignmentDto | null>(null)
  const [open, setOpen] = useState(false)
  const { tasks, loading, refetch } = useOperationalTasks(businessId, enabled)

  const triggerAfterCheckIn = useCallback(async () => {
    if (!enabled) return
    invalidateOperationalTasksCache(businessId)
    await refetch(true)
    const assignment = await fetchSpotlightAssignment(businessId)
    if (!assignment) return
    const forceShow = !assignment.lastSpotlightAt
    if (!forceShow && wasSpotlightShownThisSession(assignment.id)) return
    setSpotlight(assignment)
    setOpen(true)
  }, [businessId, enabled, refetch])

  const close = useCallback(() => {
    setOpen(false)
    if (spotlight) markSpotlightShownSession(spotlight.id)
  }, [spotlight])

  const openManual = useCallback((a: OperationalTaskAssignmentDto) => {
    setSpotlight(a)
    setOpen(true)
  }, [])

  const handleUpdated = useCallback(() => {
    invalidateOperationalTasksCache(businessId)
    void refetch(true)
  }, [businessId, refetch])

  return {
    tasks,
    loading,
    refetch,
    spotlight,
    open,
    triggerAfterCheckIn,
    close,
    openManual,
    handleUpdated,
  }
}
