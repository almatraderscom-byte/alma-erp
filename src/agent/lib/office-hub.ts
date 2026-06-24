/**
 * Office Owner Hub — server-side data for the owner's centralized office view.
 *
 * Reads from `staff_tasks` (the existing task engine) plus the Phase-A office
 * tables (`office_comments`, `office_task_events`, `office_weekly_awards`). No
 * mutations here — actions go through /api/assistant/office/action.
 */
import { prisma } from '@/lib/prisma'
import { buildStaffFriendlyDetail } from '@/agent/lib/staff-task-format'
import { computeWeeklyScores } from '@/agent/lib/office-award'

const ACTIVE_STATUSES = ['sent', 'approved', 'carried'] as const

/** Verification states that put a task in the owner's approval queue. */
const PENDING_REVIEW_VS = ['proof_submitted', 'auto_verified'] as const

/** Minutes before an unanswered update request is escalated to the owner. */
export const UPDATE_ESCALATE_MINUTES = 10

export type OfficeAuthor = 'owner' | 'staff' | 'agent' | 'system'

export type HubTaskCard = {
  id: string
  title: string
  detail: string | null
  type: string
  productRef: string | null
  status: string
  verificationStatus: string
  proofType: string | null
  proofData: Record<string, unknown> | null
  reviewerNote: string | null
  redoCount: number
  source: string
  staffId: string
  staffName: string
  createdAt: string
}

export type OverdueUpdateCard = {
  id: string
  title: string
  staffId: string
  staffName: string
  requestedAt: string
  requestedBy: string | null
  note: string | null
  /** Seconds left before owner escalation (negative = already overdue). */
  secondsLeft: number
  escalated: boolean
}

export type ActivityItem = {
  id: string
  taskId: string
  kind: string
  summary: string
  actorType: string
  createdAt: string
}

export type HubAward = {
  staffId: string
  staffName: string
  score: number
  auto: boolean
  pinnedByOwner: boolean
  note: string | null
  weekStart: string
} | null

/** Headline stats for the gold "Performer of the Week" hero (winner only). */
export type AwardStats = {
  done: number
  /** % of the winner's reviewed proofs that the owner approved this week (0–100), or null if none reviewed. */
  approvalRate: number | null
  /** Average auto-QC score of the winner's proofs this week (0–100), or null if none scored. */
  avgQc: number | null
  selfInitiated: number
}

/** A row in the right-rail "Team Status" panel. */
export type TeamMember = {
  staffId: string
  name: string
  initial: string
  status: 'on' | 'lunch' | 'off'
  sub: string
  doneToday: number
  totalToday: number
}

/** A row in the right-rail weekly performance leaderboard. */
export type LeaderRow = {
  staffId: string
  name: string
  initial: string
  score: number
  /** Bar width 0–100 relative to the top score. */
  pct: number
}

export type OwnerHubData = {
  businessId: string
  kpis: { pending: number; active: number; overdue: number; doneToday: number; online: number; staffTotal: number }
  pendingApproval: HubTaskCard[]
  activeTasks: HubTaskCard[]
  selfInitiated: HubTaskCard[]
  overdueUpdates: OverdueUpdateCard[]
  activity: ActivityItem[]
  award: HubAward
  awardStats: AwardStats | null
  team: TeamMember[]
  leaderboard: LeaderRow[]
}

/** Dhaka-local YYYY-MM-DD. */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Pull an auto-QC score (0–100) out of proofData if one was stored. */
function pickQc(v: unknown): number | null {
  const r = asRecord(v)
  if (!r) return null
  for (const k of ['qcScore', 'qc', 'score', 'autoQc']) {
    const val = r[k]
    if (typeof val === 'number' && val >= 0 && val <= 100) return val
  }
  return null
}

function initialOf(name: string): string {
  const t = name.trim()
  return t ? t[0].toUpperCase() : '?'
}

function toCard(t: {
  id: string
  title: string
  detail: string | null
  type: string
  productRef: string | null
  status: string
  verificationStatus: string
  proofType: string | null
  proofData: unknown
  reviewerNote: string | null
  redoCount: number
  source: string
  staffId: string
  createdAt: Date
  staff: { name: string } | null
}): HubTaskCard {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    type: t.type,
    productRef: t.productRef,
    status: t.status,
    verificationStatus: t.verificationStatus,
    proofType: t.proofType,
    proofData: asRecord(t.proofData),
    reviewerNote: t.reviewerNote,
    redoCount: t.redoCount ?? 0,
    source: t.source,
    staffId: t.staffId,
    staffName: t.staff?.name ?? 'অজানা',
    createdAt: t.createdAt.toISOString(),
  }
}

const CARD_SELECT = {
  id: true,
  title: true,
  detail: true,
  type: true,
  productRef: true,
  status: true,
  verificationStatus: true,
  proofType: true,
  proofData: true,
  reviewerNote: true,
  redoCount: true,
  source: true,
  staffId: true,
  createdAt: true,
  staff: { select: { name: true } },
} as const

export async function getOwnerHubData(businessId = 'ALMA_LIFESTYLE'): Promise<OwnerHubData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()

  const weekStartDate = (() => {
    // Monday 00:00 UTC anchoring the current Dhaka week (mirrors office-award).
    const dhaka = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
    const dow = dhaka.getDay()
    const diff = (dow + 6) % 7
    const monday = new Date(dhaka)
    monday.setDate(dhaka.getDate() - diff)
    const ymd = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
    return new Date(`${ymd}T00:00:00Z`)
  })()
  const weekEndDate = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [pendingRows, selfRows, activeRows, activeCount, doneToday, updateRows, events, awardRow, staffList, todayTasks, weekStatRows, scores] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { businessId, verificationStatus: { in: [...PENDING_REVIEW_VS] } },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, status: 'proposed', source: 'staff_initiated' },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.findMany({
      where: {
        businessId,
        proposedFor: todayDate,
        status: { in: [...ACTIVE_STATUSES] },
        verificationStatus: { notIn: [...PENDING_REVIEW_VS] },
      },
      orderBy: { createdAt: 'asc' },
      take: 12,
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.count({
      where: { businessId, proposedFor: todayDate, status: { in: [...ACTIVE_STATUSES] } },
    }),
    prisma.agentStaffTask.count({
      where: { businessId, proposedFor: todayDate, status: 'done' },
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, updateRequestedAt: { not: null } },
      orderBy: { updateRequestedAt: 'asc' },
      select: {
        id: true,
        title: true,
        staffId: true,
        updateRequestedAt: true,
        updateRequestedBy: true,
        updateRequestNote: true,
        lastStaffUpdateAt: true,
        escalatedAt: true,
        status: true,
        staff: { select: { name: true } },
      },
    }),
    prisma.officeTaskEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, taskId: true, kind: true, summary: true, actorType: true, createdAt: true },
    }),
    prisma.officeWeeklyAward.findFirst({
      where: { businessId },
      orderBy: { weekStart: 'desc' },
      select: {
        staffId: true,
        score: true,
        auto: true,
        pinnedByOwner: true,
        note: true,
        weekStart: true,
        staff: { select: { name: true } },
      },
    }),
    prisma.agentStaff.findMany({
      where: { businessId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: todayDate },
      select: { staffId: true, status: true, title: true, type: true, verificationStatus: true, updateRequestedAt: true, lastStaffUpdateAt: true },
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: { gte: weekStartDate, lt: weekEndDate } },
      select: { staffId: true, status: true, verificationStatus: true, source: true, proofData: true },
    }),
    computeWeeklyScores(businessId, weekStartDate),
  ])

  // Overdue updates: a request is open until the staff answers it (a later
  // lastStaffUpdateAt) or it's resolved. Still-open ones drive the countdown.
  const overdueUpdates: OverdueUpdateCard[] = updateRows
    .filter((t) => {
      if (t.status === 'done') return false
      if (!t.updateRequestedAt) return false
      const answered = t.lastStaffUpdateAt && t.lastStaffUpdateAt.getTime() >= t.updateRequestedAt.getTime()
      return !answered
    })
    .map((t) => {
      const reqMs = t.updateRequestedAt!.getTime()
      const deadline = reqMs + UPDATE_ESCALATE_MINUTES * 60_000
      return {
        id: t.id,
        title: t.title,
        staffId: t.staffId,
        staffName: t.staff?.name ?? 'অজানা',
        requestedAt: t.updateRequestedAt!.toISOString(),
        requestedBy: t.updateRequestedBy,
        note: t.updateRequestNote,
        secondsLeft: Math.round((deadline - now) / 1000),
        escalated: Boolean(t.escalatedAt),
      }
    })

  let award: HubAward = null
  if (awardRow) {
    award = {
      staffId: awardRow.staffId,
      staffName: awardRow.staff?.name ?? 'অজানা',
      score: awardRow.score,
      auto: awardRow.auto,
      pinnedByOwner: awardRow.pinnedByOwner,
      note: awardRow.note,
      weekStart: awardRow.weekStart.toISOString().slice(0, 10),
    }
  }

  // ── Team status (right rail): each active staff's today counts + a status. ──
  type TodayAgg = { done: number; total: number; current: string | null; active: number }
  const byStaffToday = new Map<string, TodayAgg>()
  for (const t of todayTasks) {
    const agg = byStaffToday.get(t.staffId) ?? { done: 0, total: 0, current: null, active: 0 }
    agg.total += 1
    if (t.status === 'done') agg.done += 1
    if ((['sent', 'approved', 'carried'] as string[]).includes(t.status)) {
      agg.active += 1
      if (!agg.current) agg.current = t.title
    }
    byStaffToday.set(t.staffId, agg)
  }
  const team: TeamMember[] = staffList.map((s) => {
    const agg = byStaffToday.get(s.id)
    const status: TeamMember['status'] = agg && (agg.active > 0 || agg.done > 0) ? 'on' : 'off'
    let sub: string
    if (!agg || agg.total === 0) {
      sub = 'আজ কোনো কাজ নেই'
    } else if (agg.current) {
      sub = `এখন: ${agg.current} · ${agg.done}/${agg.total} কাজ আজ`
    } else if (agg.done >= agg.total) {
      sub = `আজকের সব কাজ শেষ · ${agg.done}/${agg.total}`
    } else {
      sub = `${agg.done}/${agg.total} কাজ আজ`
    }
    return { staffId: s.id, name: s.name, initial: initialOf(s.name), status, sub, doneToday: agg?.done ?? 0, totalToday: agg?.total ?? 0 }
  })
  const onlineCount = team.filter((m) => m.status !== 'off').length

  // ── Weekly leaderboard (right rail) ──
  const topScore = scores.reduce((m, s) => Math.max(m, s.score), 0)
  const leaderboard: LeaderRow[] = scores.slice(0, 5).map((s) => ({
    staffId: s.staffId,
    name: s.staffName,
    initial: initialOf(s.staffName),
    score: s.score,
    pct: topScore > 0 ? Math.max(6, Math.round((s.score / topScore) * 100)) : 0,
  }))

  // ── Award headline stats (winner only) ──
  let awardStats: AwardStats | null = null
  if (award) {
    const mine = weekStatRows.filter((t) => t.staffId === award!.staffId)
    const done = mine.filter((t) => t.status === 'done').length
    const reviewed = mine.filter((t) =>
      (['owner_approved', 'redo_requested', 'proof_submitted', 'auto_verified'] as string[]).includes(t.verificationStatus),
    )
    const approved = mine.filter((t) => t.verificationStatus === 'owner_approved').length
    const qcs = mine.map((t) => pickQc(t.proofData)).filter((n): n is number => n !== null)
    awardStats = {
      done,
      approvalRate: reviewed.length > 0 ? Math.round((approved / reviewed.length) * 100) : null,
      avgQc: qcs.length > 0 ? Math.round((qcs.reduce((a, b) => a + b, 0) / qcs.length) * 10) / 10 : null,
      selfInitiated: mine.filter((t) => t.source === 'staff_initiated' && t.status === 'done').length,
    }
  }

  return {
    businessId,
    kpis: {
      pending: pendingRows.length,
      active: activeCount,
      overdue: overdueUpdates.length,
      doneToday,
      online: onlineCount,
      staffTotal: team.length,
    },
    pendingApproval: pendingRows.map(toCard),
    activeTasks: activeRows.map(toCard),
    selfInitiated: selfRows.map(toCard),
    overdueUpdates,
    activity: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      summary: e.summary,
      actorType: e.actorType,
      createdAt: e.createdAt.toISOString(),
    })),
    award,
    awardStats,
    team,
    leaderboard,
  }
}

export type ThreadMessage = {
  id: string
  authorType: string
  authorStaffId: string | null
  kind: string
  body: string
  attachments: unknown
  createdAt: string
}

export type TaskThread = {
  task: HubTaskCard | null
  comments: ThreadMessage[]
  events: ActivityItem[]
}

// ── Staff-side office data ──────────────────────────────────────────────────

export type StaffTaskCard = HubTaskCard & {
  needsUpdate: boolean
  updateNote: string | null
  updateSecondsLeft: number
  proofImageUrl: string | null
  friendlyDetail: string
}

export type StaffOfficeData = {
  staffId: string
  staffName: string
  businessId: string
  today: string
  active: StaffTaskCard[]
  done: StaffTaskCard[]
  proposals: StaffTaskCard[]
  isWinner: boolean
  award: HubAward
}

function pickImage(data: Record<string, unknown> | null): string | null {
  if (!data) return null
  for (const k of ['imageUrl', 'image', 'photo', 'url', 'fileUrl']) {
    const v = data[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  return null
}

const VISIBLE_STAFF_STATUSES = ['sent', 'approved', 'carried', 'awaiting_proof', 'done'] as const

export async function getStaffOfficeData(
  staff: { id: string; name: string; businessId: string },
): Promise<StaffOfficeData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()

  const [rows, proposalRows, awardRow] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, proposedFor: todayDate, status: { in: [...VISIBLE_STAFF_STATUSES] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, status: 'proposed', source: 'staff_initiated' },
      orderBy: { createdAt: 'desc' },
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.officeWeeklyAward.findFirst({
      where: { businessId: staff.businessId },
      orderBy: { weekStart: 'desc' },
      select: { staffId: true, score: true, auto: true, pinnedByOwner: true, note: true, weekStart: true, staff: { select: { name: true } } },
    }),
  ])

  const toStaffCard = (t: (typeof rows)[number]): StaffTaskCard => {
    const base = toCard(t)
    const reqAt = t.updateRequestedAt
    const answered = reqAt && t.lastStaffUpdateAt && t.lastStaffUpdateAt.getTime() >= reqAt.getTime()
    const needsUpdate = Boolean(reqAt) && !answered && t.status !== 'done'
    const deadline = reqAt ? reqAt.getTime() + UPDATE_ESCALATE_MINUTES * 60_000 : 0
    return {
      ...base,
      needsUpdate,
      updateNote: t.updateRequestNote ?? null,
      updateSecondsLeft: reqAt ? Math.round((deadline - now) / 1000) : 0,
      proofImageUrl: pickImage(base.proofData),
      friendlyDetail: buildStaffFriendlyDetail({
        title: t.title,
        type: t.type,
        productRef: t.productRef,
        detail: t.detail,
      }),
    }
  }

  const cards = rows.map(toStaffCard)
  const active = cards.filter((c) => c.status !== 'done')
  const done = cards.filter((c) => c.status === 'done')

  let award: HubAward = null
  if (awardRow) {
    award = {
      staffId: awardRow.staffId,
      staffName: awardRow.staff?.name ?? 'অজানা',
      score: awardRow.score,
      auto: awardRow.auto,
      pinnedByOwner: awardRow.pinnedByOwner,
      note: awardRow.note,
      weekStart: awardRow.weekStart.toISOString().slice(0, 10),
    }
  }

  return {
    staffId: staff.id,
    staffName: staff.name,
    businessId: staff.businessId,
    today,
    active,
    done,
    proposals: proposalRows.map(toStaffCard),
    isWinner: Boolean(awardRow && awardRow.staffId === staff.id),
    award,
  }
}

// ── Day-end history / archive ───────────────────────────────────────────────
//
// The office board for any past day is reconstructed on demand from the durable
// `agent_staff_task` records (keyed by `proposedFor`, the Dhaka calendar date)
// plus that day's `office_task_event` rows. No snapshot table or end-of-day job
// is needed — the source records already persist, so "yesterday's board" is just
// a date-filtered read of the same data the live board uses.

/** Bangla pretty date label, e.g. "২৪ জুন, মঙ্গলবার", from a YYYY-MM-DD string. */
function bnDayLabel(ymd: string): string {
  const d = new Date(`${ymd}T06:00:00Z`) // noon-ish Dhaka, avoids TZ edge flips
  const dm = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' }).format(d)
  const wd = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(d)
  return `${dm}, ${wd}`
}

export type ArchiveDaySummary = {
  date: string
  label: string
  total: number
  done: number
  approved: number
  staffCount: number
}

export type ArchiveStaffRow = {
  staffId: string
  name: string
  initial: string
  done: number
  total: number
}

export type ArchiveDay = {
  date: string
  label: string
  kpis: { total: number; done: number; approved: number; redo: number; selfInitiated: number; staffCount: number }
  tasks: HubTaskCard[]
  perStaff: ArchiveStaffRow[]
  activity: ActivityItem[]
}

/** Distinct past Dhaka days (most-recent first) that have at least one task. */
export async function getOfficeHistoryIndex(businessId = 'ALMA_LIFESTYLE', limit = 30): Promise<ArchiveDaySummary[]> {
  const todayDate = new Date(`${dhakaToday()}T00:00:00Z`)
  const rows = await prisma.agentStaffTask.findMany({
    where: { businessId, proposedFor: { lt: todayDate } },
    select: { proposedFor: true, status: true, verificationStatus: true, staffId: true },
  })

  const byDay = new Map<string, { total: number; done: number; approved: number; staff: Set<string> }>()
  for (const r of rows) {
    if (!r.proposedFor) continue
    const key = r.proposedFor.toISOString().slice(0, 10)
    const agg = byDay.get(key) ?? { total: 0, done: 0, approved: 0, staff: new Set<string>() }
    agg.total += 1
    if (r.status === 'done') agg.done += 1
    if (r.verificationStatus === 'owner_approved') agg.approved += 1
    agg.staff.add(r.staffId)
    byDay.set(key, agg)
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([date, agg]) => ({
      date,
      label: bnDayLabel(date),
      total: agg.total,
      done: agg.done,
      approved: agg.approved,
      staffCount: agg.staff.size,
    }))
}

/** Full read-only board for one past Dhaka day. */
export async function getOfficeHistoryDay(businessId: string, date: string): Promise<ArchiveDay | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const dayDate = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(dayDate.getTime())) return null
  const nextDay = new Date(dayDate.getTime() + 24 * 60 * 60 * 1000)
  // Dhaka (UTC+6) calendar day maps to this UTC instant window for events.
  const sixH = 6 * 60 * 60 * 1000
  const evGte = new Date(dayDate.getTime() - sixH)
  const evLt = new Date(nextDay.getTime() - sixH)

  const [tasks, events, staffList] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: dayDate },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.officeTaskEvent.findMany({
      where: { businessId, createdAt: { gte: evGte, lt: evLt } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, taskId: true, kind: true, summary: true, actorType: true, createdAt: true },
    }),
    prisma.agentStaff.findMany({ where: { businessId }, select: { id: true, name: true } }),
  ])

  if (tasks.length === 0) return null

  const cards = tasks.map(toCard)
  const nameById = new Map(staffList.map((s) => [s.id, s.name]))

  const perStaffMap = new Map<string, ArchiveStaffRow>()
  for (const t of tasks) {
    const name = nameById.get(t.staffId) ?? t.staff?.name ?? 'অজানা'
    const row = perStaffMap.get(t.staffId) ?? { staffId: t.staffId, name, initial: initialOf(name), done: 0, total: 0 }
    row.total += 1
    if (t.status === 'done') row.done += 1
    perStaffMap.set(t.staffId, row)
  }

  return {
    date,
    label: bnDayLabel(date),
    kpis: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      approved: tasks.filter((t) => t.verificationStatus === 'owner_approved').length,
      redo: tasks.filter((t) => t.verificationStatus === 'redo_requested').length,
      selfInitiated: tasks.filter((t) => t.source === 'staff_initiated').length,
      staffCount: perStaffMap.size,
    },
    tasks: cards,
    perStaff: [...perStaffMap.values()].sort((a, b) => b.done - a.done),
    activity: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      summary: e.summary,
      actorType: e.actorType,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}

export async function getTaskThread(taskId: string, businessId = 'ALMA_LIFESTYLE'): Promise<TaskThread> {
  const [task, comments, events] = await Promise.all([
    prisma.agentStaffTask.findFirst({
      where: { id: taskId, businessId },
      select: CARD_SELECT,
    }),
    prisma.officeComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        authorType: true,
        authorStaffId: true,
        kind: true,
        body: true,
        attachments: true,
        createdAt: true,
      },
    }),
    prisma.officeTaskEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, taskId: true, kind: true, summary: true, actorType: true, createdAt: true },
    }),
  ])

  return {
    task: task ? toCard(task) : null,
    comments: comments.map((c) => ({
      id: c.id,
      authorType: c.authorType,
      authorStaffId: c.authorStaffId,
      kind: c.kind,
      body: c.body,
      attachments: c.attachments,
      createdAt: c.createdAt.toISOString(),
    })),
    events: events.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      summary: e.summary,
      actorType: e.actorType,
      createdAt: e.createdAt.toISOString(),
    })),
  }
}
