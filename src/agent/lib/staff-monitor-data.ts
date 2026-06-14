import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { getActiveDispatchTaskIdsForDate } from '@/agent/lib/staff-dispatch-sync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DONE_STATUSES = new Set(['done', 'verified', 'done_unverified', 'awaiting_proof'])
const STARTED_STATUSES = new Set(['awaiting_proof', 'done', 'verified', 'done_unverified'])

export type StaffMonitorRow = {
  id: string
  staffId: string | null
  staffName: string | null
  businessId: string | null
  type: string
  content: string
  status: string
  telegramMessageId: string | null
  errorReason: string | null
  relatedTaskIds: unknown
  createdAt: string
  sentAt: string | null
}

export type StaffSummary = {
  staffId: string
  staffName: string
  dispatched: number
  delivered: number
  failed: number
  tasksTotal: number
  tasksDone: number
  completionPct: number
  started: boolean
  lastActivityAt: string | null
}

export type StaffMonitorData = {
  today: string
  feed: StaffMonitorRow[]
  failures: StaffMonitorRow[]
  staffSummaries: StaffSummary[]
  typeCounts: Record<string, number>
  mismatches: Array<{
    staffId: string
    staffName: string
    outboxId: string
    errorReason: string | null
    relatedTaskIds: string[]
  }>
  generatedAt: string
}

function mapOutbox(row: {
  id: string
  staffId: string | null
  staffName: string | null
  businessId: string | null
  type: string
  content: string
  status: string
  telegramMessageId: string | null
  errorReason: string | null
  relatedTaskIds: unknown
  createdAt: Date
  sentAt: Date | null
}): StaffMonitorRow {
  return {
    id: row.id,
    staffId: row.staffId,
    staffName: row.staffName,
    businessId: row.businessId,
    type: row.type,
    content: row.content,
    status: row.status,
    telegramMessageId: row.telegramMessageId,
    errorReason: row.errorReason,
    relatedTaskIds: row.relatedTaskIds,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  }
}

export async function getStaffMonitorData(): Promise<StaffMonitorData> {
  const today = todayYmdDhaka()
  const todayStart = new Date(`${today}T00:00:00+06:00`)

  const [todayTasks, todayOutbox, dispatchTaskIds] = await Promise.all([
    db.agentStaffTask.findMany({
      where: {
        proposedFor: new Date(today),
        status: { notIn: ['cancelled', 'proposed', 'approved'] },
        type: { not: 'learning' },
      },
      include: { staff: { select: { id: true, name: true } } },
    }),
    prisma.agentOutbox.findMany({
      where: { createdAt: { gte: todayStart } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    getActiveDispatchTaskIdsForDate(today),
  ])

  const scopedTasks = dispatchTaskIds?.length
    ? (todayTasks as Array<{ id: string }>).filter((t) => dispatchTaskIds.includes(t.id))
    : todayTasks

  const feed = todayOutbox.map(mapOutbox)
  const failures = feed.filter((f) => f.status === 'failed')
  const typeCounts: Record<string, number> = {}
  for (const row of feed) {
    typeCounts[row.type] = (typeCounts[row.type] ?? 0) + 1
  }

  const staffMap = new Map<string, StaffSummary>()

  for (const t of scopedTasks as Array<{
    staffId: string
    status: string
    staff: { name: string }
    updatedAt?: Date
    createdAt: Date
  }>) {
    const sid = t.staffId
    const name = t.staff?.name ?? 'স্টাফ'
    staffMap.set(sid, staffMap.get(sid) ?? {
      staffId: sid,
      staffName: name,
      dispatched: 0,
      delivered: 0,
      failed: 0,
      tasksTotal: 0,
      tasksDone: 0,
      completionPct: 0,
      started: false,
      lastActivityAt: null,
    })
    const s = staffMap.get(sid)!
    s.tasksTotal++
    if (DONE_STATUSES.has(t.status)) s.tasksDone++
    if (STARTED_STATUSES.has(t.status)) s.started = true
  }

  for (const row of todayOutbox) {
    if (!row.staffId) continue
    const sid = row.staffId
    if (!staffMap.has(sid)) {
      staffMap.set(sid, {
        staffId: sid,
        staffName: row.staffName ?? 'স্টাফ',
        dispatched: 0,
        delivered: 0,
        failed: 0,
        tasksTotal: 0,
        tasksDone: 0,
        completionPct: 0,
        started: false,
        lastActivityAt: null,
      })
    }
    const s = staffMap.get(sid)!
    s.dispatched++
    if (row.status === 'delivered') s.delivered++
    if (row.status === 'failed') s.failed++
    const activityAt = (row.sentAt ?? row.createdAt).toISOString()
    if (!s.lastActivityAt || activityAt > s.lastActivityAt) {
      s.lastActivityAt = activityAt
    }
  }

  const staffSummaries = [...staffMap.values()].map((s) => ({
    ...s,
    completionPct: s.tasksTotal ? Math.round((s.tasksDone / s.tasksTotal) * 100) : 0,
  }))

  const mismatches: StaffMonitorData['mismatches'] = []
  for (const row of todayOutbox) {
    if (row.type !== 'task_dispatch' || row.status !== 'failed' || !row.staffId) continue
    const taskIds = Array.isArray(row.relatedTaskIds)
      ? (row.relatedTaskIds as string[])
      : []
    const hasSentTasks = (scopedTasks as Array<{ staffId: string; id: string; status: string }>).some(
      (t) => t.staffId === row.staffId && t.status === 'sent' && (taskIds.length === 0 || taskIds.includes(t.id)),
    )
    if (hasSentTasks) {
      mismatches.push({
        staffId: row.staffId,
        staffName: row.staffName ?? 'স্টাফ',
        outboxId: row.id,
        errorReason: row.errorReason,
        relatedTaskIds: taskIds,
      })
    }
  }

  return {
    today,
    feed,
    failures,
    staffSummaries,
    typeCounts,
    mismatches,
    generatedAt: new Date().toISOString(),
  }
}
