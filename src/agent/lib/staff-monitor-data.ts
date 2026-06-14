import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, daysAgoYmd, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import { getActiveDispatchTaskIdsForDate } from '@/agent/lib/staff-dispatch-sync'
import {
  dutiesForToday,
  CONTINUOUS_SERVICES,
  type AgentDutyRow,
  type ContinuousServiceHealth,
  type SalahDutyRow,
} from '@/agent/lib/agent-duties'
import { isEffectivelyDone } from '@/agent/lib/salah-resolve'
import { HEARTBEAT_STALE_MS } from '@/agent/lib/constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DONE_STATUSES = new Set(['done', 'verified', 'done_unverified', 'awaiting_proof'])
const STARTED_STATUSES = new Set(['awaiting_proof', 'done', 'verified', 'done_unverified'])

export type MonitorWarning = {
  severity: 'critical' | 'warn'
  kind: string
  message: string
}

export type DutyHistoryDay = {
  date: string
  duties: AgentDutyRow[]
}

export type SchedulerHealth = {
  ackEscalationLastRun: string | null
  schedulersHeartbeatAt: string | null
  queueHeartbeatAt: string | null
}

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
  requiresAck: boolean
  acknowledgedAt: string | null
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
  feedDays: number
  agentDuties: AgentDutyRow[]
  dutyHistory: DutyHistoryDay[]
  salahDuties: SalahDutyRow[]
  continuousServices: ContinuousServiceHealth[]
  schedulerHealth: SchedulerHealth
  warnings: MonitorWarning[]
  unackedMessages: StaffMonitorRow[]
  feed: StaffMonitorRow[]
  historyFeed: StaffMonitorRow[]
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
  requiresAck: boolean
  acknowledgedAt: Date | null
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
    requiresAck: row.requiresAck,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  }
}

const WAQT_BN: Record<string, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

function waqtBangla(waqt: string): string {
  return WAQT_BN[waqt] ?? waqt
}

const TYPE_LABELS_SHORT: Record<string, string> = {
  task_dispatch: 'টাস্ক',
  announcement: 'ঘোষণা',
  reminder: 'রিমাইন্ডার',
}

function typeLabelShort(type: string): string {
  return TYPE_LABELS_SHORT[type] ?? type
}

function fmtDhakaTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function getSalahDutiesForToday(today: string): Promise<SalahDutyRow[]> {
  const records = await db.agentSalahRecord.findMany({
    where: { date: dhakaMidnightUtc(today) },
    orderBy: { windowStart: 'asc' },
  }) as Array<{
    waqt: string
    status: string
    windowStart: Date
    windowEnd: Date
    confirmedAt: Date | null
    remindersSent: number
  }>

  const now = new Date()
  return records.map((r) => {
    const done = isEffectivelyDone(
      { status: r.status, confirmedAt: r.confirmedAt, windowStart: r.windowStart },
      now,
    )
    const missed = !done && (r.status === 'missed' || now > new Date(r.windowEnd))
    const status: SalahDutyRow['status'] = done ? 'done' : missed ? 'missed' : 'pending'
    return {
      waqt: r.waqt,
      label: waqtBangla(r.waqt),
      scheduledTime: fmtDhakaTime(r.windowStart),
      status,
      doneTime: done && r.confirmedAt ? fmtDhakaTime(r.confirmedAt) : null,
      reminders: r.remindersSent,
    }
  })
}

async function getAgentDutiesForToday(today: string): Promise<AgentDutyRow[]> {
  const rows = await db.agentDutyLog.findMany({
    where: { dutyDate: today },
  }) as Array<{
    id: string
    duty: string
    label: string
    dutyDate: string
    status: string
    detail: string | null
    ranAt: Date | null
    createdAt: Date
  }>
  const byDuty = new Map(rows.map((r) => [r.duty, r]))
  return dutiesForToday().map((d) => {
    const row = byDuty.get(d.duty)
    const time = d.time ?? null
    if (row) {
      return {
        id: row.id,
        duty: row.duty,
        label: row.label,
        dutyDate: row.dutyDate,
        status: row.status as AgentDutyRow['status'],
        detail: row.detail,
        ranAt: row.ranAt?.toISOString() ?? null,
        time,
        createdAt: row.createdAt.toISOString(),
      }
    }
    return {
      id: `pending-${d.duty}`,
      duty: d.duty,
      label: d.label,
      dutyDate: today,
      status: 'pending' as const,
      detail: null,
      ranAt: null,
      time,
      createdAt: new Date().toISOString(),
    }
  })
}

function heartbeatFresh(lastBeatAt: Date | null | undefined, maxMs = HEARTBEAT_STALE_MS): boolean {
  if (!lastBeatAt) return false
  return Date.now() - lastBeatAt.getTime() <= maxMs
}

async function getContinuousServicesHealth(): Promise<{
  services: ContinuousServiceHealth[]
  schedulersHeartbeatAt: Date | null
  queueHeartbeatAt: Date | null
}> {
  const rows = await db.agentHeartbeat.findMany({
    where: { service: { in: ['schedulers', 'queue-consumer'] } },
    select: { service: true, lastBeatAt: true },
  }) as Array<{ service: string; lastBeatAt: Date }>

  const byService = new Map(rows.map((r) => [r.service, r.lastBeatAt]))
  const schedulersBeat = byService.get('schedulers') ?? null
  const queueBeat = byService.get('queue-consumer') ?? null
  const schedulersOk = heartbeatFresh(schedulersBeat)
  const queueOk = heartbeatFresh(queueBeat, 120_000)

  const services = CONTINUOUS_SERVICES.map((s) => ({
    key: s.key,
    label: s.label,
    healthy: s.key === 'cs_services' ? schedulersOk && queueOk : schedulersOk,
  }))

  return { services, schedulersHeartbeatAt: schedulersBeat, queueHeartbeatAt: queueBeat }
}

async function getSchedulerHealth(): Promise<SchedulerHealth> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: 'scheduler:last_run:ack-escalation' },
  })
  let ackEscalationLastRun: string | null = null
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as { at?: string }
      ackEscalationLastRun = parsed.at ?? row.value
    } catch {
      ackEscalationLastRun = row.value
    }
  }
  const hb = await getContinuousServicesHealth()
  return {
    ackEscalationLastRun,
    schedulersHeartbeatAt: hb.schedulersHeartbeatAt?.toISOString() ?? null,
    queueHeartbeatAt: hb.queueHeartbeatAt?.toISOString() ?? null,
  }
}

async function getDutyHistory(days: number): Promise<DutyHistoryDay[]> {
  const today = todayYmdDhaka()
  const dates = Array.from({ length: days }, (_, i) => daysAgoYmd(i))
  const rows = await db.agentDutyLog.findMany({
    where: { dutyDate: { in: dates } },
    orderBy: [{ dutyDate: 'desc' }, { duty: 'asc' }],
  }) as Array<{
    id: string
    duty: string
    label: string
    dutyDate: string
    status: string
    detail: string | null
    ranAt: Date | null
    createdAt: Date
  }>

  const byDate = new Map<string, AgentDutyRow[]>()
  for (const date of dates) byDate.set(date, [])

  for (const row of rows) {
    const list = byDate.get(row.dutyDate) ?? []
    const def = dutiesForToday().find((d) => d.duty === row.duty)
    list.push({
      id: row.id,
      duty: row.duty,
      label: row.label,
      dutyDate: row.dutyDate,
      status: row.status as AgentDutyRow['status'],
      detail: row.detail,
      ranAt: row.ranAt?.toISOString() ?? null,
      time: def?.time ?? null,
      createdAt: row.createdAt.toISOString(),
    })
    byDate.set(row.dutyDate, list)
  }

  return dates.map((date) => ({ date, duties: byDate.get(date) ?? [] }))
}

export async function getStaffMonitorData(opts: { historyDays?: number } = {}): Promise<StaffMonitorData> {
  const historyDays = Math.min(Math.max(opts.historyDays ?? 7, 1), 14)
  const today = todayYmdDhaka()
  const todayStart = dhakaDayBounds(today).start
  const historyStart = dhakaDayBounds(daysAgoYmd(historyDays - 1)).start
  const tenMinAgo = new Date(Date.now() - 10 * 60_000)

  const [todayTasks, todayOutbox, historyOutbox, unackedRows, dispatchTaskIds, agentDuties, salahDuties, hbPack, dutyHistory, schedulerHealth] = await Promise.all([
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
    prisma.agentOutbox.findMany({
      where: { createdAt: { gte: historyStart, lt: todayStart } },
      orderBy: { createdAt: 'desc' },
      take: 400,
    }),
    prisma.agentOutbox.findMany({
      where: {
        requiresAck: true,
        status: 'delivered',
        acknowledgedAt: null,
        sentAt: { lt: tenMinAgo },
      },
      orderBy: { sentAt: 'asc' },
      take: 50,
    }),
    getActiveDispatchTaskIdsForDate(today),
    getAgentDutiesForToday(today),
    getSalahDutiesForToday(today),
    getContinuousServicesHealth(),
    getDutyHistory(historyDays),
    getSchedulerHealth(),
  ])

  const continuousServices = hbPack.services

  const scopedTasks = dispatchTaskIds?.length
    ? (todayTasks as Array<{ id: string }>).filter((t) => dispatchTaskIds.includes(t.id))
    : todayTasks

  const feed = todayOutbox.map(mapOutbox)
  const historyFeed = historyOutbox.map(mapOutbox)
  const unackedMessages = unackedRows.map(mapOutbox)
  const failures = feed.filter((f) => f.status === 'failed')
  const skippedOffhours = feed.filter((f) => f.status === 'skipped_offhours')
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

  const warnings: MonitorWarning[] = []

  if (!continuousServices.every((s) => s.healthy)) {
    warnings.push({
      severity: 'critical',
      kind: 'worker_heartbeat',
      message: 'Worker heartbeat stale — schedulers/queue-consumer চেক করুন (pm2 logs agent-worker)',
    })
  }

  if (schedulerHealth.ackEscalationLastRun) {
    const ageMs = Date.now() - new Date(schedulerHealth.ackEscalationLastRun).getTime()
    if (ageMs > 12 * 60_000) {
      warnings.push({
        severity: 'critical',
        kind: 'ack_escalation_stale',
        message: `Ack escalation ${Math.round(ageMs / 60_000)} মিনিট ধরে চালেনি — ১০ মিনিট unseen alert কাজ করছে না`,
      })
    }
  } else {
    warnings.push({
      severity: 'warn',
      kind: 'ack_escalation_unknown',
      message: 'Ack escalation last-run লগ নেই — worker SCHEDULERS_ENABLED চেক করুন',
    })
  }

  for (const m of unackedMessages) {
    warnings.push({
      severity: 'critical',
      kind: 'unacked_message',
      message: `${m.staffName ?? 'স্টাফ'} ১০+ মিনিট মেসেজ দেখেননি (${typeLabelShort(m.type)})`,
    })
  }

  for (const d of agentDuties.filter((x) => x.status === 'missed' || x.status === 'failed')) {
    warnings.push({
      severity: d.status === 'missed' ? 'critical' : 'warn',
      kind: 'duty_' + d.status,
      message: `${d.label} — ${d.detail ?? d.status}`,
    })
  }

  if (skippedOffhours.length > 0) {
    warnings.push({
      severity: 'warn',
      kind: 'skipped_offhours',
      message: `${skippedOffhours.length}টি মেসেজ office hours-এর বাইরে পাঠানো হয়নি (skipped_offhours)`,
    })
  }

  return {
    today,
    feedDays: historyDays,
    agentDuties,
    dutyHistory,
    salahDuties,
    continuousServices,
    schedulerHealth,
    warnings,
    unackedMessages,
    feed,
    historyFeed,
    failures,
    staffSummaries,
    typeCounts,
    mismatches,
    generatedAt: new Date().toISOString(),
  }
}
