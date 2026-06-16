/**
 * Single todo list display order: agent office tasks first, owner requests below.
 */
export function todoSourceTier(source: string): number {
  if (source === 'day_shift' || source === 'scheduler' || source === 'agent') return 0
  if (source === 'owner') return 1
  return 2
}

export function compareTodosForDisplay(
  a: { source: string; priority: string; status: string; createdAt: Date | string },
  b: { source: string; priority: string; status: string; createdAt: Date | string },
): number {
  const tier = todoSourceTier(a.source) - todoSourceTier(b.source)
  if (tier !== 0) return tier

  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
  const pa = priorityRank[a.priority] ?? 2
  const pb = priorityRank[b.priority] ?? 2
  if (pa !== pb) return pa - pb

  const statusRank: Record<string, number> = { in_progress: 0, running: 0, pending: 1, completed: 2, cancelled: 3 }
  const sa = statusRank[a.status] ?? 1
  const sb = statusRank[b.status] ?? 1
  if (sa !== sb) return sa - sb

  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

export function sortTodosForDisplay<T extends { source: string; priority: string; status: string; createdAt: Date | string }>(
  todos: T[],
): T[] {
  return [...todos].sort(compareTodosForDisplay)
}

export function todoSourceLabel(source: string): string | null {
  if (source === 'day_shift' || source === 'scheduler') return 'Office'
  if (source === 'agent') return 'Agent'
  if (source === 'owner') return 'Sir'
  return null
}
