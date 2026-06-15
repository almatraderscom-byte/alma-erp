/**
 * Keep dispatch_staff_tasks pending actions in sync with staff_tasks DB.
 * Source of truth: all rows with status=proposed for the date.
 */
import { prisma } from '@/lib/prisma'
import {
  buildRichDispatchSummary,
  type FormattableStaffTask,
  type RichDispatchOpts,
  type StaffDispatchBreakdown,
} from '@/agent/lib/staff-task-format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ProposedTaskRow = {
  id: string
  title: string
  type: string
  source?: string
  staff: { name: string }
}

type BusinessFilter = string | null | undefined

function buildBusinessClause(businessId: BusinessFilter): Record<string, unknown> {
  return businessId ? { businessId } : {}
}

export async function loadProposedTasksForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<ProposedTaskRow[]> {
  return db.agentStaffTask.findMany({
    where: { proposedFor: new Date(date), status: 'proposed', ...buildBusinessClause(businessId) },
    include: { staff: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  })
}

/** Already dispatched — sent (pending Done) or done. Excludes approved (not yet sent). */
export async function loadPriorActiveTasksForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<FormattableStaffTask[]> {
  const rows = await db.agentStaffTask.findMany({
    where: {
      proposedFor: new Date(date),
      status: { in: ['sent', 'done'] },
      ...buildBusinessClause(businessId),
    },
    include: { staff: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r: {
    id: string
    title: string
    type: string
    status: string
    source?: string
    staff: { name: string }
  }) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    source: r.source,
    staff: r.staff,
  }))
}

export async function getDispatchBreakdownForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<StaffDispatchBreakdown> {
  const rows = await db.agentStaffTask.findMany({
    where: {
      proposedFor: new Date(date),
      status: { notIn: ['cancelled'] },
      ...buildBusinessClause(businessId),
    },
    include: { staff: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const byStaff = new Map<string, StaffDispatchBreakdown['perStaff'][number]>()
  let proposedToDispatch = 0
  let alreadySentPending = 0
  let alreadyDone = 0

  for (const r of rows as Array<{
    title: string
    status: string
    staff: { name: string }
  }>) {
    const name = r.staff.name
    if (!byStaff.has(name)) {
      byStaff.set(name, {
        name,
        sentPending: 0,
        done: 0,
        proposed: 0,
        approved: 0,
        sentPendingTitles: [],
        proposedTitles: [],
      })
    }
    const s = byStaff.get(name)!
    if (r.status === 'sent') {
      s.sentPending++
      s.sentPendingTitles.push(r.title)
      alreadySentPending++
    } else if (r.status === 'done') {
      s.done++
      alreadyDone++
    } else if (r.status === 'proposed') {
      s.proposed++
      s.proposedTitles.push(r.title)
      proposedToDispatch++
    } else if (r.status === 'approved') {
      s.approved++
    }
  }

  return {
    date,
    proposedToDispatch,
    alreadySentPending,
    alreadyDone,
    perStaff: [...byStaff.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** True when there are proposed tasks left to approve/dispatch for the date. */
export async function hasProposedTasksForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<number> {
  return db.agentStaffTask.count({
    where: { proposedFor: new Date(date), status: 'proposed', ...buildBusinessClause(businessId) },
  })
}

export async function buildDispatchSummary(
  date: string,
  proposed: ProposedTaskRow[],
  richOpts?: RichDispatchOpts,
  businessId?: BusinessFilter,
): Promise<string> {
  const priorActive = await loadPriorActiveTasksForDate(date, businessId)
  const proposedFmt: FormattableStaffTask[] = proposed.map((t) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    status: 'proposed',
    source: t.source,
    staff: t.staff,
  }))
  return buildRichDispatchSummary(date, proposedFmt, priorActive, richOpts)
}

type DispatchPayload = {
  date?: string
  taskIds?: string[]
  changedStaff?: string
  newTaskIds?: string[]
  businessId?: string
}

/** Latest executed/approved dispatch for a date — authoritative task scope for monitor/progress. */
export async function getActiveDispatchTaskIdsForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<string[] | null> {
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: 'dispatch_staff_tasks',
      status: { in: ['executed', 'approved'] },
      ...buildBusinessClause(businessId),
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
export async function syncPendingDispatchAction(
  date: string,
  richOpts?: RichDispatchOpts,
  businessId?: BusinessFilter,
): Promise<string | null> {
  const proposed = await loadProposedTasksForDate(date, businessId)
  if (!proposed.length) return null

  const taskIds = proposed.map((t) => t.id)
  const summaryText = await buildDispatchSummary(date, proposed, richOpts, businessId)

  const existing = await db.agentPendingAction.findFirst({
    where: {
      type: 'dispatch_staff_tasks',
      status: 'pending',
      ...buildBusinessClause(businessId),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })

  const payload: DispatchPayload = {
    date,
    taskIds,
    changedStaff: richOpts?.changedStaff,
    newTaskIds: richOpts?.newTaskIds,
    businessId: businessId ?? undefined,
  }

  if (existing) {
    await db.agentPendingAction.update({
      where: { id: existing.id },
      data: { payload, summary: summaryText },
    })
    return existing.id as string
  }

  const action = await db.agentPendingAction.create({
    data: {
      type: 'dispatch_staff_tasks',
      payload,
      summary: summaryText,
      costEstimate: 0,
      status: 'pending',
      ...(businessId ? { businessId } : {}),
    },
  })
  return action.id as string
}

/** Approve every proposed task for the date (not stale payload.taskIds). */
export async function approveAllProposedTasksForDate(
  date: string,
  businessId?: BusinessFilter,
): Promise<number> {
  const result = await db.agentStaffTask.updateMany({
    where: { proposedFor: new Date(date), status: 'proposed', ...buildBusinessClause(businessId) },
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
  businessId?: BusinessFilter,
): Promise<RefreshApproveResult> {
  const proposed = await loadProposedTasksForDate(date, businessId)
  if (!proposed.length) return { ok: false, reason: 'no_proposed' }

  const taskIds = proposed.map((t) => t.id)
  const summaryText = await buildDispatchSummary(date, proposed, undefined, businessId)
  const payload: DispatchPayload = { date, taskIds, businessId: businessId ?? undefined }

  let actionId: string | undefined = preferredActionId
  if (actionId) {
    const row = await db.agentPendingAction.findUnique({
      where: { id: actionId },
      select: { id: true, type: true, status: true, businessId: true },
    })
    if (
      !row
      || row.type !== 'dispatch_staff_tasks'
      || row.status !== 'pending'
      || (businessId && row.businessId !== businessId)
    ) {
      actionId = undefined
    }
  }

  if (!actionId) {
    const synced = await syncPendingDispatchAction(date, undefined, businessId)
    if (!synced) {
      const action = await db.agentPendingAction.create({
        data: {
          type: 'dispatch_staff_tasks',
          payload,
          summary: summaryText,
          costEstimate: 0,
          status: 'pending',
          ...(businessId ? { businessId } : {}),
        },
      })
      actionId = action.id as string
    } else {
      actionId = synced
    }
  }

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: { payload, summary: summaryText },
  })

  const count = await approveAllProposedTasksForDate(date, businessId)

  await db.agentPendingAction.updateMany({
    where: {
      id: { not: actionId },
      type: 'dispatch_staff_tasks',
      status: 'pending',
      ...buildBusinessClause(businessId),
    },
    data: { status: 'superseded', resolvedAt: new Date() },
  })

  await db.agentPendingAction.update({
    where: { id: actionId },
    data: {
      status: 'approved',
      resolvedAt: new Date(),
      payload,
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
export async function prepareCorrectedDispatchPending(
  date: string,
  businessId?: BusinessFilter,
): Promise<PrepareCorrectedResult> {
  const proposed = await loadProposedTasksForDate(date, businessId)
  if (!proposed.length) return { ok: false, reason: 'no_proposed' }

  const cancelled = await db.agentStaffTask.updateMany({
    where: {
      proposedFor: new Date(date),
      status: { notIn: ['proposed', 'cancelled'] },
      ...buildBusinessClause(businessId),
    },
    data: { status: 'cancelled' },
  })

  const openActions = await db.agentPendingAction.findMany({
    where: {
      type: 'dispatch_staff_tasks',
      status: { in: ['pending', 'approved'] },
      ...buildBusinessClause(businessId),
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

  const pendingActionId = await syncPendingDispatchAction(date, undefined, businessId)
  if (!pendingActionId) return { ok: false, reason: 'no_proposed' }

  const taskIds = proposed.map((t) => t.id)
  return {
    ok: true,
    pendingActionId,
    date,
    cancelledCount: cancelled.count as number,
    proposedCount: proposed.length,
    taskIds,
    summaryBangla: await buildDispatchSummary(date, proposed, undefined, businessId),
  }
}
