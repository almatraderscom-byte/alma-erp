import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, daysAgoYmd, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import { getActiveDispatchTaskIdsForDate } from '@/agent/lib/staff-dispatch-sync'
import {
  dutiesForToday,
  CONTINUOUS_SERVICES,
} from '@/agent/lib/agent-duties'
import { isEffectivelyDone } from '@/agent/lib/salah-resolve'
import { HEARTBEAT_STALE_MS } from '@/agent/lib/constants'
import type {
  ActiveReminderRow,
  ActiveTodoRow,
  AgentDutyRow,
  ContinuousServiceHealth,
  GeoStaffStatus,
  MonitorWarning,
  PendingApprovalRow,
  ProductivityAlert,
  SalahDutyRow,
  SchedulerHealth,
  StaffMonitorData,
  StaffMonitorRow,
  StaffSummary,
} from '@/agent/lib/staff-monitor-types'

export type {
  ActiveReminderRow,
  ActiveTodoRow,
  AgentDutyRow,
  ContinuousServiceHealth,
  MonitorWarning,
  PendingApprovalRow,
  SalahDutyRow,
  SchedulerHealth,
  StaffMonitorData,
  StaffMonitorRow,
  StaffSummary,
} from '@/agent/lib/staff-monitor-types'

async function getDutyTimeOverrides(): Promise<Record<string, string>> {
  const rows = await prisma.agentKvSetting.findMany({
    where: { key: { startsWith: 'duty.time.' } },
  })
  const overrides: Record<string, string> = {}
  for (const r of rows) {
    const dutyKey = r.key.replace('duty.time.', '')
    if (dutyKey === '_changed') continue
    try {
      const parsed = JSON.parse(r.value) as { dhakaTime?: string }
      if (parsed.dhakaTime) overrides[dutyKey] = parsed.dhakaTime
    } catch {
      if (/^\d{2}:\d{2}$/.test(r.value)) overrides[dutyKey] = r.value
    }
  }
  return overrides
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DONE_STATUSES = new Set(['done', 'verified', 'done_unverified', 'awaiting_proof'])
const STARTED_STATUSES = new Set(['awaiting_proof', 'done', 'verified', 'done_unverified'])

export type DutyHistoryDay = {
  date: string
  duties: AgentDutyRow[]
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

const OFFICE_LAT = Number(process.env.OFFICE_ALMA_LIFESTYLE_LAT || process.env.OFFICE_LAT || 0)
const OFFICE_LNG = Number(process.env.OFFICE_ALMA_LIFESTYLE_LNG || process.env.OFFICE_LNG || 0)
const OFFICE_RADIUS_M = Number(process.env.OFFICE_ALMA_LIFESTYLE_RADIUS_M || process.env.OFFICE_RADIUS_M || 300)

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function getGeoStatus(): Promise<GeoStaffStatus[]> {
  if (!OFFICE_LAT || !OFFICE_LNG) return []
  const staff = await db.agentStaff.findMany({ where: { active: true, businessId: 'ALMA_LIFESTYLE' }, select: { id: true, name: true } })
  const results: GeoStaffStatus[] = []
  for (const s of staff as Array<{ id: string; name: string }>) {
    const loc = await db.agentStaffLocation.findFirst({ where: { staffId: s.id }, orderBy: { recordedAt: 'desc' } })
    if (!loc) { results.push({ staffId: s.id, staffName: s.name, status: 'no_data' }); continue }
    const ageMin = (Date.now() - new Date(loc.recordedAt).getTime()) / 60_000
    if (ageMin > 10) { results.push({ staffId: s.id, staffName: s.name, status: 'stale', lastUpdate: loc.recordedAt.toISOString() }); continue }
    const dist = haversineM(OFFICE_LAT, OFFICE_LNG, loc.lat, loc.lng)
    const inZone = dist <= OFFICE_RADIUS_M
    results.push({
      staffId: s.id, staffName: s.name,
      status: inZone ? 'in_zone' : 'outside',
      distanceM: Math.round(dist),
      lastUpdate: loc.recordedAt.toISOString(),
      mapsLink: inZone ? undefined : `https://www.google.com/maps?q=${loc.lat},${loc.lng}`,
    })
  }
  return results
}

async function getProductivityAlerts(): Promise<ProductivityAlert[]> {
  const today = todayYmdDhaka()
  const alerts: ProductivityAlert[] = []
  const proofKeys = await prisma.agentKvSetting.findMany({ where: { key: { startsWith: `proof_requests:${today}:` } } })
  for (const row of proofKeys) {
    try {
      const v = JSON.parse(row.value) as { count?: number; lastSentAt?: string }
      if (v.lastSentAt) {
        const staffId = row.key.split(':')[2]
        const staff = await db.agentStaff.findUnique({ where: { id: staffId }, select: { name: true } })
        alerts.push({ staffId, staffName: staff?.name ?? 'Staff', type: 'proof_sent', message: `প্রুফ পাঠানো হয়েছে (${v.count ?? 1}x আজ)`, at: v.lastSentAt })
      }
    } catch { /* skip */ }
  }
  const idleKey = await prisma.agentKvSetting.findUnique({ where: { key: `idle_alert:${today}` } })
  if (idleKey?.value) {
    try {
      const v = JSON.parse(idleKey.value) as { staffIds?: string[] }
      for (const sid of v.staffIds ?? []) {
        const staff = await db.agentStaff.findUnique({ where: { id: sid }, select: { name: true } })
        alerts.push({ staffId: sid, staffName: staff?.name ?? 'Staff', type: 'idle', message: '২+ ঘণ্টা নিষ্ক্রিয়', at: new Date().toISOString() })
      }
    } catch { /* skip */ }
  }
  return alerts
}

export async function getStaffMonitorData(opts: { historyDays?: number } = {}): Promise<StaffMonitorData> {
  const historyDays = Math.min(Math.max(opts.historyDays ?? 7, 1), 14)
  const today = todayYmdDhaka()
  const todayStart = dhakaDayBounds(today).start
  const tenMinAgo = new Date(Date.now() - 10 * 60_000)
  const historyDates = Array.from({ length: historyDays - 1 }, (_, i) => daysAgoYmd(i + 1))

  const [todayTasks, todayOutbox, unackedRows, dispatchTaskIds, agentDuties, salahDuties, hbPack, schedulerHealth, reminderRows, todoRows, approvalRows, dutyTimeOverrides] = await Promise.all([
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
    getSchedulerHealth(),
    db.agentReminder.findMany({
      where: { status: { in: ['pending', 'sent', 'snoozed'] } },
      orderBy: { dueAt: 'asc' },
      take: 30,
    }),
    db.agentOwnerTodo.findMany({
      where: { status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.agentPendingAction.findMany({
      where: {
        status: { in: ['pending', 'waiting_list'] },
        createdAt: { gte: new Date(Date.now() - 48 * 3600_000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    getDutyTimeOverrides(),
  ])

  const continuousServices = hbPack.services

  const [geoStatus, productivityAlerts] = await Promise.all([
    getGeoStatus().catch(() => [] as GeoStaffStatus[]),
    getProductivityAlerts().catch(() => [] as ProductivityAlert[]),
  ])

  const activeReminders = (reminderRows as Array<{
    id: string; title: string; body: string | null; dueAt: Date; tier: number
    status: string; snoozedUntil: Date | null; recurrenceRrule: string | null
  }>).map(r => ({
    id: r.id,
    title: r.title,
    body: r.body,
    dueAt: r.dueAt.toISOString(),
    tier: r.tier,
    status: r.status,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    isRecurring: !!r.recurrenceRrule,
  }))

  const activeTodos = (todoRows as Array<{
    id: string; title: string; detail: string | null; status: string
    priority: string; dueHint: string | null; createdAt: Date
  }>).map(t => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    priority: t.priority,
    dueHint: t.dueHint,
    createdAt: t.createdAt.toISOString(),
  }))

  const pendingApprovals = (approvalRows as Array<{
    id: string; type: string; summary: string; status: string
    businessId: string; createdAt: Date; payload: unknown
  }>).map(a => ({
    id: a.id,
    type: a.type,
    summary: a.summary,
    status: a.status,
    businessId: a.businessId,
    createdAt: a.createdAt.toISOString(),
    staffName: (a.payload as Record<string, unknown>)?.staffName as string | null ?? null,
  }))

  const scopedTasks = dispatchTaskIds?.length
    ? (todayTasks as Array<{ id: string }>).filter((t) => dispatchTaskIds.includes(t.id))
    : todayTasks

  const feed = todayOutbox.map(mapOutbox)
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
    isHistorical: false,
    historyDates,
    agentDuties,
    salahDuties,
    continuousServices,
    schedulerHealth,
    warnings,
    unackedMessages,
    feed,
    failures,
    staffSummaries,
    typeCounts,
    mismatches,
    activeReminders,
    activeTodos,
    pendingApprovals,
    dutyTimeOverrides,
    geoStatus,
    productivityAlerts,
    generatedAt: new Date().toISOString(),
  }
}

export async function getStaffMonitorForDate(date: string): Promise<StaffMonitorData> {
  const bounds = dhakaDayBounds(date)
  const [dayTasks, dayOutbox, dispatchTaskIds, dutyRows] = await Promise.all([
    db.agentStaffTask.findMany({
      where: {
        proposedFor: new Date(date),
        status: { notIn: ['cancelled', 'proposed', 'approved'] },
        type: { not: 'learning' },
      },
      include: { staff: { select: { id: true, name: true } } },
    }),
    prisma.agentOutbox.findMany({
      where: { createdAt: { gte: bounds.start, lt: bounds.end } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    }),
    getActiveDispatchTaskIdsForDate(date),
    db.agentDutyLog.findMany({ where: { dutyDate: date }, orderBy: { duty: 'asc' } }),
  ])

  const scopedTasks = dispatchTaskIds?.length
    ? (dayTasks as Array<{ id: string }>).filter((t) => dispatchTaskIds.includes(t.id))
    : dayTasks

  const feed = dayOutbox.map(mapOutbox)
  const failures = feed.filter((f) => f.status === 'failed')
  const typeCounts: Record<string, number> = {}
  for (const row of feed) typeCounts[row.type] = (typeCounts[row.type] ?? 0) + 1

  const staffMap = new Map<string, StaffSummary>()
  for (const t of scopedTasks as Array<{ staffId: string; status: string; staff: { name: string } }>) {
    const sid = t.staffId
    const name = t.staff?.name ?? 'স্টাফ'
    staffMap.set(sid, staffMap.get(sid) ?? {
      staffId: sid, staffName: name, dispatched: 0, delivered: 0, failed: 0,
      tasksTotal: 0, tasksDone: 0, completionPct: 0, started: false, lastActivityAt: null,
    })
    const s = staffMap.get(sid)!
    s.tasksTotal++
    if (DONE_STATUSES.has(t.status)) s.tasksDone++
    if (STARTED_STATUSES.has(t.status)) s.started = true
  }
  for (const row of dayOutbox) {
    if (!row.staffId) continue
    const sid = row.staffId
    if (!staffMap.has(sid)) {
      staffMap.set(sid, {
        staffId: sid, staffName: row.staffName ?? 'স্টাফ', dispatched: 0, delivered: 0, failed: 0,
        tasksTotal: 0, tasksDone: 0, completionPct: 0, started: false, lastActivityAt: null,
      })
    }
    const s = staffMap.get(sid)!
    s.dispatched++
    if (row.status === 'delivered') s.delivered++
    if (row.status === 'failed') s.failed++
    const activityAt = (row.sentAt ?? row.createdAt).toISOString()
    if (!s.lastActivityAt || activityAt > s.lastActivityAt) s.lastActivityAt = activityAt
  }
  const staffSummaries = [...staffMap.values()].map((s) => ({
    ...s,
    completionPct: s.tasksTotal ? Math.round((s.tasksDone / s.tasksTotal) * 100) : 0,
  }))

  const agentDuties: AgentDutyRow[] = (dutyRows as Array<{
    id: string; duty: string; label: string; dutyDate: string; status: string
    detail: string | null; ranAt: Date | null; createdAt: Date
  }>).map((row) => {
    const def = dutiesForToday().find((d) => d.duty === row.duty)
    return {
      id: row.id,
      duty: row.duty,
      label: row.label,
      dutyDate: row.dutyDate,
      status: row.status as AgentDutyRow['status'],
      detail: row.detail,
      ranAt: row.ranAt?.toISOString() ?? null,
      time: def?.time ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  })

  const warnings: MonitorWarning[] = []
  if (failures.length) {
    warnings.push({
      severity: 'warn',
      kind: 'historical_failures',
      message: `${date}: ${failures.length}টি মেসেজ পৌঁছায়নি (আর্কাইভ)`,
    })
  }

  return {
    today: date,
    feedDays: 1,
    isHistorical: true,
    agentDuties,
    salahDuties: [],
    continuousServices: [],
    schedulerHealth: { ackEscalationLastRun: null, schedulersHeartbeatAt: null, queueHeartbeatAt: null },
    warnings,
    unackedMessages: [],
    feed,
    failures,
    staffSummaries,
    typeCounts,
    mismatches: [],
    generatedAt: new Date().toISOString(),
  }
}
