/**
 * Keep dispatch_staff_tasks pending actions in sync with staff_tasks DB.
 * Source of truth: all rows with status=proposed for the date.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ProposedTaskRow = {
  id: string
  title: string
  type: string
  staff: { name: string }
}

export async function loadProposedTasksForDate(date: string): Promise<ProposedTaskRow[]> {
  return db.agentStaffTask.findMany({
    where: { proposedFor: new Date(date), status: 'proposed' },
    include: { staff: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  })
}

export function buildDispatchSummary(date: string, proposed: ProposedTaskRow[]): string {
  const lines = proposed.map(
    (t) => `• ${t.staff.name}: ${t.title} (${t.type})`,
  )
  return `স্টাফ টাস্ক ডিসপ্যাচ — ${date}\n\n${lines.join('\n')}`
}

type DispatchPayload = { date?: string; taskIds?: string[] }

/** Latest executed/approved dispatch for a date — authoritative task scope for monitor/progress. */
export async function getActiveDispatchTaskIdsForDate(date: string): Promise<string[] | null> {
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: 'dispatch_staff_tasks',
      status: { in: ['executed', 'approved'] },
    },
    orderBy: { resolvedAt: 'desc' },
    select: { payload: true },
    take: 30,
  })
  const match = rows.find((r: { payload: DispatchPayload }) => {
    const p = r.payload as DispatchPayload
    return p?.date === date && Array.isArray(p.taskIds) && p.taskIds.length > 0
  })
  return match ? ((match.payload as DispatchPayload).taskIds ?? null) : null
}

/** Rebuild pending action payload + summary from current proposed tasks in DB. */
export async function syncPendingDispatchAction(date: string): Promise<string | null> {
  const proposed = await loadProposedTasksForDate(date)
  if (!proposed.length) return null

  const taskIds = proposed.map((t) => t.id)
  const summaryText = buildDispatchSummary(date, proposed)

  const existing = await db.agentPendingAction.findFirst({
    where: { type: 'dispatch_staff_tasks', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })

  if (existing) {
    await db.agentPendingAction.update({
      where: { id: existing.id },
      data: {
        payload: { ...(existing.payload as object), date, taskIds },
        summary: summaryText,
      },
    })
    return existing.id as string
  }

  const action = await db.agentPendingAction.create({
    data: {
      type: 'dispatch_staff_tasks',
      payload: { date, taskIds },
      summary: summaryText,
      costEstimate: 0,
      status: 'pending',
    },
  })
  return action.id as string
}

/** Approve every proposed task for the date (not stale payload.taskIds). */
export async function approveAllProposedTasksForDate(date: string): Promise<number> {
  const result = await db.agentStaffTask.updateMany({
    where: { proposedFor: new Date(date), status: 'proposed' },
    data: { status: 'approved' },
  })
  return result.count as number
}

export type RefreshApproveResult =
  | { ok: true; pendingActionId: string; date: string; taskCount: number; taskIds: string[] }
  | { ok: false; reason: 'no_proposed' | 'no_pending' }

/**
 * Refresh pending payload from DB, then flip all proposed → approved and mark action approved.
 * @param preferredActionId — UI/Telegram approve button id (payload refreshed on this row).
 */
export async function refreshAndApproveDispatch(
  date: string,
  preferredActionId?: string,
): Promise<RefreshApproveResult> {
  const proposed = await loadProposedTasksForDate(date)
  if (!proposed.length) return { ok: false, reason: 'no_proposed' }

  const taskIds = proposed.map((t) => t.id)
  const summaryText = buildDispatchSummary(date, proposed)

  let actionId: string | undefined = preferredActionId
  if (actionId) {
    const row = await db.agentPendingAction.findUnique({
      where: { id: actionId },
      select: { id: true, type: true, status: true },
    })
    if (!row || row.type !== 'dispatch_staff_tasks' || row.status !== 'pending') {
      actionId = undefined
    }
  }

  if (!actionId) {
    const synced = await syncPendingDispatchAction(date)
    if (!synced) {
      const action = await db.agentPendingAction.create({
        data: {
          type: 'dispatch_staff_tasks',
          payload: { date, taskIds },
          summary: summaryText,
          costEstimate: 0,
          status: 'pending',
        },
      })
      actionId = action.id as string
    } else {
      actionId = synced
    }
  }

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: {
      payload: { date, taskIds },
      summary: summaryText,
    },
  })

  const count = await approveAllProposedTasksForDate(date)

  await db.agentPendingAction.updateMany({
    where: {
      id: { not: actionId },
      type: 'dispatch_staff_tasks',
      status: 'pending',
    },
    data: { status: 'superseded', resolvedAt: new Date() },
  })

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: {
      status: 'approved',
      resolvedAt: new Date(),
      payload: { date, taskIds },
      summary: summaryText,
    },
  })

  return { ok: true, pendingActionId: actionId, date, taskCount: count, taskIds }
}

export type PrepareCorrectedResult =
  | {
      ok: true
      pendingActionId: string
      date: string
      cancelledCount: number
      proposedCount: number
      taskIds: string[]
      summaryBangla: string
    }
  | { ok: false; reason: 'no_proposed' }

/**
 * Cancel wrong sent/approved tasks and create a PENDING dispatch card from DB proposed rows.
 * Does NOT approve or dispatch — owner must approve explicitly.
 */
export async function prepareCorrectedDispatchPending(date: string): Promise<PrepareCorrectedResult> {
  const proposed = await loadProposedTasksForDate(date)
  if (!proposed.length) return { ok: false, reason: 'no_proposed' }

  // Cancel ALL superseded work (including done/awaiting_proof from wrong dispatch).
  const cancelled = await db.agentStaffTask.updateMany({
    where: {
      proposedFor: new Date(date),
      status: { notIn: ['proposed', 'cancelled'] },
    },
    data: { status: 'cancelled' },
  })

  const openActions = await db.agentPendingAction.findMany({
    where: {
      type: 'dispatch_staff_tasks',
      status: { in: ['pending', 'approved'] },
    },
    select: { id: true, payload: true },
  })
  for (const a of openActions) {
    const p = a.payload as { date?: string }
    if (p.date === date) {
      await db.agentPendingAction.update({
        where: { id: a.id },
        data: {
          status: 'superseded',
          resolvedAt: new Date(),
          result: { reason: 'corrected_redispatch_pending' },
        },
      })
    }
  }

  const pendingActionId = await syncPendingDispatchAction(date)
  if (!pendingActionId) return { ok: false, reason: 'no_proposed' }

  const taskIds = proposed.map((t) => t.id)
  return {
    ok: true,
    pendingActionId,
    date,
    cancelledCount: cancelled.count as number,
    proposedCount: proposed.length,
    taskIds,
    summaryBangla: buildDispatchSummary(date, proposed),
  }
}
