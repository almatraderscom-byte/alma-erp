/**
 * Scope task counts to the latest executed/approved dispatch for a date.
 * Prevents stale done/sent rows from superseded dispatches inflating progress totals.
 */

export async function fetchActiveDispatchTaskIds(supabase, dateYmd) {
  const { data, error } = await supabase
    .from('agent_pending_actions')
    .select('payload, status, resolvedAt')
    .eq('type', 'dispatch_staff_tasks')
    .in('status', ['executed', 'approved'])
    .order('resolvedAt', { ascending: false })
    .limit(30)
  if (error) throw new Error(error.message)

  const row = (data ?? []).find(
    (a) =>
      a.payload?.date === dateYmd
      && Array.isArray(a.payload?.taskIds)
      && a.payload.taskIds.length > 0,
  )
  return row?.payload?.taskIds ?? null
}

export function filterTasksToActiveDispatch(tasks, dispatchTaskIds) {
  if (!dispatchTaskIds?.length) return tasks
  const allowed = new Set(dispatchTaskIds)
  return tasks.filter((t) => allowed.has(t.id))
}
