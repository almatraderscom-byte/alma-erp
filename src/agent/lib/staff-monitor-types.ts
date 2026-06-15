/** Client-safe staff monitor types — no Prisma / server imports. */

export type MonitorWarning = {
  severity: 'critical' | 'warn'
  kind: string
  message: string
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

export type AgentDutyRow = {
  id: string
  duty: string
  label: string
  dutyDate: string
  status: 'pending' | 'done' | 'failed' | 'missed' | 'skipped'
  detail: string | null
  ranAt: string | null
  time: string | null
  createdAt: string
}

export type SalahDutyRow = {
  waqt: string
  label: string
  scheduledTime: string
  status: 'pending' | 'done' | 'missed'
  doneTime: string | null
  reminders: number
}

export type ContinuousServiceHealth = {
  key: string
  label: string
  healthy: boolean
}

export type DutyHistoryDay = {
  date: string
  duties: AgentDutyRow[]
}

export type StaffMonitorData = {
  today: string
  feedDays: number
  isHistorical?: boolean
  historyDates?: string[]
  agentDuties: AgentDutyRow[]
  dutyHistory?: DutyHistoryDay[]
  salahDuties: SalahDutyRow[]
  continuousServices: ContinuousServiceHealth[]
  schedulerHealth: SchedulerHealth
  warnings: MonitorWarning[]
  unackedMessages: StaffMonitorRow[]
  feed: StaffMonitorRow[]
  historyFeed?: StaffMonitorRow[]
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
