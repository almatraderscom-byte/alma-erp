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
import { computeStaffPerformance, type StaffPerformance } from '@/agent/lib/office-performance'
import { listPendingProposals, type ProposalCard } from '@/agent/lib/office-proposals'
import { userAvatarUrl } from '@/lib/user-display'

/** Build the stable avatar-route URL for a staff's linked ERP user, if a photo is set. */
function staffImageUrl(
  user: { id: string; profileImageUrl: string | null; updatedAt: Date | null } | null | undefined,
): string | null {
  if (!user || !user.profileImageUrl) return null
  return userAvatarUrl(user.id, user.updatedAt)
}

/** Minimal `staff.user` select used wherever we want a profile photo. */
const STAFF_USER_SELECT = { select: { id: true, profileImageUrl: true, updatedAt: true } } as const

const ACTIVE_STATUSES = ['sent', 'approved', 'carried'] as const

/** Verification states that put a task in the owner's approval queue. */
const PENDING_REVIEW_VS = ['proof_submitted', 'auto_verified'] as const

/** Minutes before an unanswered update request is escalated to the owner. */
export const UPDATE_ESCALATE_MINUTES = 10

/**
 * Days an unfinished/pending task is allowed to linger on the LIVE office board.
 * The board only ever shows the last `STALE_TASK_DAYS` days of still-open work, so
 * a task abandoned long ago can't keep inflating the counts (e.g. "৩২ কাজ" when
 * there are really only 5–6). Older items still exist in the durable records and
 * surface in the day-by-day history — they just stop cluttering "today".
 */
export const STALE_TASK_DAYS = 2

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
  /** Owner-set deadline (ISO), or null if none set yet. */
  dueAt: string | null
  /** Supervisor couldn't auto-verify/understand this → owner must review (the ~10%). */
  needsOwner: boolean
  /** Owner pinned this task to always escalate (never agent-auto-resolve). */
  alwaysEscalate: boolean
}

export type OverdueUpdateCard = {
  id: string
  title: string
  staffId: string
  staffName: string
  /** Staff's phone (from linked ERP user) for the owner's quick-call button. */
  phone: string | null
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
  /** Winner's real ERP profile photo, or null to fall back to an initial. */
  imageUrl: string | null
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
  imageUrl: string | null
  status: 'on' | 'lunch' | 'off'
  sub: string
  doneToday: number
  totalToday: number
  /** True when the staff has checked in today (attendance) and not checked out. */
  checkedIn: boolean
  /** Bangla check-in time label (e.g. "৯:০৫ AM"), or null if not checked in. */
  checkInLabel: string | null
}

/** A row in the right-rail weekly performance leaderboard. */
export type LeaderRow = {
  staffId: string
  name: string
  initial: string
  imageUrl: string | null
  score: number
  /** Bar width 0–100 relative to the top score. */
  pct: number
}

export type OwnerHubData = {
  businessId: string
  kpis: { pending: number; active: number; overdue: number; doneToday: number; online: number; staffTotal: number }
  pendingApproval: HubTaskCard[]
  activeTasks: HubTaskCard[]
  /** Today's completed tasks (for the at-a-glance todolist). */
  doneTodayTasks: HubTaskCard[]
  selfInitiated: HubTaskCard[]
  overdueUpdates: OverdueUpdateCard[]
  activity: ActivityItem[]
  award: HubAward
  awardStats: AwardStats | null
  team: TeamMember[]
  leaderboard: LeaderRow[]
  /** Per-staff performance scorecard for the current week (Phase 3). */
  performance: StaffPerformance[]
  /** Pending penalty/reward proposals awaiting the owner's decision (Phase 3). */
  proposals: ProposalCard[]
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

/** Dhaka-local clock label in Bangla numerals, e.g. "৯:০৫ AM". */
function bnTime(d: Date): string {
  return new Intl.DateTimeFormat('bn-BD', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
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
  dueAt?: Date | null
  supervisorNeedsOwner?: boolean
  supervisorAlwaysEscalate?: boolean
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
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    needsOwner: Boolean(t.supervisorNeedsOwner),
    alwaysEscalate: Boolean(t.supervisorAlwaysEscalate),
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
  dueAt: true,
  supervisorNeedsOwner: true,
  supervisorAlwaysEscalate: true,
  staff: { select: { name: true } },
} as const

export async function getOwnerHubData(businessId = 'ALMA_LIFESTYLE'): Promise<OwnerHubData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()
  // Live board horizon: only show still-open work from the last STALE_TASK_DAYS.
  const staleCutoff = new Date(todayDate.getTime() - STALE_TASK_DAYS * 86_400_000)

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

  const lunchDate = today // Dhaka YYYY-MM-DD, matches StaffLunch.lunchDate
  const [pendingRows, selfRows, activeRows, activeCount, doneToday, updateRows, events, awardRow, staffList, todayTasks, weekStatRows, scores, openLunch, attendanceRows, performance, proposals, doneTaskRows] = await Promise.all([
    prisma.agentStaffTask.findMany({
      // Owner review queue: proof awaiting review + anything the supervisor
      // couldn't auto-verify/understand and handed to the owner (the ~10%).
      // `status: { not: 'done' }` on the whole query is essential: the agent's
      // auto-verify sets verificationStatus='auto_verified' AND status='done'
      // together, so without this guard an AI-approved DONE task would still
      // match the review queue — double-counting it as both "pending" and
      // "done" across the KPIs, approval list and todolist. Done = done.
      where: {
        businessId,
        status: { not: 'done' },
        // Don't let approvals abandoned for more than STALE_TASK_DAYS keep
        // counting against "today" — they fall off the live queue (still in history).
        proposedFor: { gte: staleCutoff },
        OR: [{ verificationStatus: { in: [...PENDING_REVIEW_VS] } }, { supervisorNeedsOwner: true }],
      },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.findMany({
      where: { businessId, status: 'proposed', source: 'staff_initiated', createdAt: { gte: staleCutoff } },
      orderBy: { createdAt: 'asc' },
      select: CARD_SELECT,
    }),
    prisma.agentStaffTask.findMany({
      where: {
        businessId,
        proposedFor: todayDate,
        status: { in: [...ACTIVE_STATUSES] },
        verificationStatus: { notIn: [...PENDING_REVIEW_VS] },
        supervisorNeedsOwner: false,
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
        staff: { select: { name: true, user: { select: { phone: true } } } },
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
        staff: { select: { name: true, user: STAFF_USER_SELECT } },
      },
    }),
    prisma.agentStaff.findMany({
      where: { businessId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, user: STAFF_USER_SELECT },
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
    prisma.staffLunch.findMany({
      where: { businessId, lunchDate, endedAt: null },
      select: { staffId: true, startedAt: true },
    }),
    // Today's attendance (ERP face check-in). attendanceDate is stored as the
    // UTC-midnight of the Dhaka calendar day (attendanceDateFor), which equals
    // `todayDate` here — so an exact match is correct. Drives office "active".
    prisma.attendanceRecord.findMany({
      where: { businessId, attendanceDate: todayDate },
      select: { userId: true, checkInAt: true, checkOutAt: true },
    }),
    computeStaffPerformance(businessId, weekStartDate),
    listPendingProposals(businessId),
    // Today's COMPLETED tasks (for the at-a-glance todolist — checked-off items).
    prisma.agentStaffTask.findMany({
      where: { businessId, proposedFor: todayDate, status: 'done' },
      orderBy: { completedAt: 'desc' },
      take: 40,
      select: CARD_SELECT,
    }),
  ])

  // Staff currently on lunch (open StaffLunch row today) → lights up the 'lunch'
  // dot in team status. The VPS worker cron owns the 45/60-min overrun alerts.
  const onLunch = new Set(openLunch.map((l) => l.staffId))
  // staffId → profile photo URL (from the linked ERP user, if any).
  const imageByStaff = new Map<string, string | null>(staffList.map((s) => [s.id, staffImageUrl(s.user)]))

  // ── Attendance → office presence ──────────────────────────────────────────
  // The office now reflects real check-in: a staff is "active" when they have
  // checked in today (and not yet checked out). Mapped via the userId link
  // (AttendanceRecord.userId == AgentStaff.userId), mirroring the worker gate.
  type Presence = { checkInAt: Date | null; checkOutAt: Date | null }
  const attendanceByUser = new Map<string, Presence>()
  for (const r of attendanceRows) {
    if (!r.userId) continue
    attendanceByUser.set(r.userId, { checkInAt: r.checkInAt ?? null, checkOutAt: r.checkOutAt ?? null })
  }
  const attendanceByStaff = new Map<string, Presence>()
  for (const s of staffList) {
    const uid = s.user?.id
    if (uid && attendanceByUser.has(uid)) attendanceByStaff.set(s.id, attendanceByUser.get(uid)!)
  }

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
        phone: t.staff?.user?.phone ?? null,
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
      imageUrl: staffImageUrl(awardRow.staff?.user) ?? imageByStaff.get(awardRow.staffId) ?? null,
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
    const lunching = onLunch.has(s.id)
    const linked = Boolean(s.user?.id)
    const att = attendanceByStaff.get(s.id)
    const checkedIn = Boolean(att?.checkInAt) && !att?.checkOutAt
    const checkedOut = Boolean(att?.checkOutAt)
    const checkInLabel = att?.checkInAt ? bnTime(att.checkInAt) : null
    const hasTaskActivity = Boolean(agg && (agg.active > 0 || agg.done > 0))

    // Presence is check-in driven for staff linked to an ERP user. Staff not
    // linked to a User can't check in, so they fall back to task-derived status.
    const status: TeamMember['status'] = lunching
      ? 'lunch'
      : checkedIn
        ? 'on'
        : linked
          ? 'off'
          : hasTaskActivity
            ? 'on'
            : 'off'

    let sub: string
    const taskTail =
      agg && agg.total > 0
        ? agg.current
          ? ` · এখন: ${agg.current} (${agg.done}/${agg.total})`
          : ` · ${agg.done}/${agg.total} কাজ`
        : ''
    if (lunching) {
      sub = '🍽️ এখন লাঞ্চে আছেন'
    } else if (checkedIn) {
      sub = `✅ চেক-ইন ${checkInLabel}${taskTail || (agg && agg.total > 0 ? '' : ' · আজ কোনো কাজ নেই')}`
    } else if (checkedOut) {
      sub = `🏁 চেক-আউট হয়ে গেছে${taskTail}`
    } else if (linked) {
      sub = agg && agg.total > 0 ? `⏳ এখনো চেক-ইন করেননি · ${agg.total} কাজ অপেক্ষায়` : '⏳ এখনো চেক-ইন করেননি'
    } else if (!agg || agg.total === 0) {
      sub = 'আজ কোনো কাজ নেই'
    } else if (agg.current) {
      sub = `এখন: ${agg.current} · ${agg.done}/${agg.total} কাজ আজ`
    } else if (agg.done >= agg.total) {
      sub = `আজকের সব কাজ শেষ · ${agg.done}/${agg.total}`
    } else {
      sub = `${agg.done}/${agg.total} কাজ আজ`
    }
    return {
      staffId: s.id,
      name: s.name,
      initial: initialOf(s.name),
      imageUrl: imageByStaff.get(s.id) ?? null,
      status,
      sub,
      doneToday: agg?.done ?? 0,
      totalToday: agg?.total ?? 0,
      checkedIn,
      checkInLabel,
    }
  })
  const onlineCount = team.filter((m) => m.status !== 'off').length

  // ── Weekly leaderboard (right rail) ──
  const topScore = scores.reduce((m, s) => Math.max(m, s.score), 0)
  const leaderboard: LeaderRow[] = scores.slice(0, 5).map((s) => ({
    staffId: s.staffId,
    name: s.staffName,
    initial: initialOf(s.staffName),
    imageUrl: imageByStaff.get(s.staffId) ?? null,
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
    doneTodayTasks: doneTaskRows.map(toCard),
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
    performance,
    proposals,
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
  /** True when this is an unfinished task carried over from a previous day
   *  (so it stays visible to the staff instead of vanishing at the day boundary). */
  carriedOver: boolean
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
  /** Open lunch today (drives the in-app 45-min timer), if any. */
  lunch: { active: boolean; startedAt: string | null }
  /** Today's attendance: drives the "active in office" banner on the staff page. */
  attendance: { checkedIn: boolean; checkedOut: boolean; checkInLabel: string | null }
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
/** Active (still-open) statuses — used to carry unfinished work across day boundaries. */
const ACTIVE_NOT_DONE_STATUSES = ['sent', 'approved', 'carried', 'awaiting_proof'] as const

export async function getStaffOfficeData(
  staff: { id: string; name: string; businessId: string; userId?: string | null },
): Promise<StaffOfficeData> {
  const today = dhakaToday()
  const todayDate = new Date(`${today}T00:00:00Z`)
  const now = Date.now()
  // Carry-over horizon: an unfinished task is carried for at most STALE_TASK_DAYS.
  const staleCutoff = new Date(todayDate.getTime() - STALE_TASK_DAYS * 86_400_000)

  const [rows, carryRows, proposalRows, awardRow, openLunch, attendanceRow] = await Promise.all([
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, proposedFor: todayDate, status: { in: [...VISIBLE_STAFF_STATUSES] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    // Carry-over: unfinished tasks from PREVIOUS days that are still open. Without
    // this, a task dispatched yesterday silently disappears at the Dhaka day
    // boundary (the board is `proposedFor: today` only) — so the staff "loses"
    // the task and any update the supervisor asked for on it. We surface them so
    // old work and its pending update-requests stay visible until actually done.
    prisma.agentStaffTask.findMany({
      where: {
        staffId: staff.id,
        status: { in: [...ACTIVE_NOT_DONE_STATUSES] },
        // Only carry the last STALE_TASK_DAYS of unfinished work — older tasks
        // stop following the staff around (and stop inflating "৩২ কাজ").
        proposedFor: { gte: staleCutoff, lt: todayDate },
      },
      orderBy: [{ updateRequestedAt: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 25,
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.agentStaffTask.findMany({
      where: { staffId: staff.id, status: 'proposed', source: 'staff_initiated', createdAt: { gte: staleCutoff } },
      orderBy: { createdAt: 'desc' },
      select: { ...CARD_SELECT, updateRequestedAt: true, updateRequestNote: true, lastStaffUpdateAt: true },
    }),
    prisma.officeWeeklyAward.findFirst({
      where: { businessId: staff.businessId },
      orderBy: { weekStart: 'desc' },
      select: { staffId: true, score: true, auto: true, pinnedByOwner: true, note: true, weekStart: true, staff: { select: { name: true, user: STAFF_USER_SELECT } } },
    }),
    prisma.staffLunch.findFirst({
      where: { staffId: staff.id, lunchDate: today, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    // The staff's own check-in for today (null when not linked / not checked in).
    staff.userId
      ? prisma.attendanceRecord.findFirst({
          where: { businessId: staff.businessId, userId: staff.userId, attendanceDate: todayDate },
          orderBy: { checkInAt: 'desc' },
          select: { checkInAt: true, checkOutAt: true },
        })
      : Promise.resolve(null),
  ])

  const toStaffCard = (t: (typeof rows)[number], carriedOver = false): StaffTaskCard => {
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
      carriedOver,
    }
  }

  const todayCards = rows.map((t) => toStaffCard(t))
  const carryCards = carryRows.map((t) => toStaffCard(t, true))
  const done = todayCards.filter((c) => c.status === 'done')

  // Tracked-first ordering so the things the supervisor is chasing surface at the
  // TOP of the staff board: pending update-request → overdue deadline → redo
  // requested → carried-over (old unfinished) → everything else. Within a bucket
  // the original (createdAt) order is preserved (V8 sort is stable).
  const trackRank = (c: StaffTaskCard): number => {
    if (c.needsUpdate) return 0
    if (c.dueAt && new Date(c.dueAt).getTime() < now) return 1
    if (c.verificationStatus === 'redo_requested') return 2
    if (c.carriedOver) return 3
    return 4
  }
  const active = [...todayCards.filter((c) => c.status !== 'done'), ...carryCards].sort(
    (a, b) => trackRank(a) - trackRank(b),
  )

  let award: HubAward = null
  if (awardRow) {
    award = {
      staffId: awardRow.staffId,
      staffName: awardRow.staff?.name ?? 'অজানা',
      imageUrl: staffImageUrl(awardRow.staff?.user),
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
    proposals: proposalRows.map((t) => toStaffCard(t)),
    isWinner: Boolean(awardRow && awardRow.staffId === staff.id),
    award,
    lunch: { active: Boolean(openLunch), startedAt: openLunch?.startedAt.toISOString() ?? null },
    attendance: {
      checkedIn: Boolean(attendanceRow?.checkInAt) && !attendanceRow?.checkOutAt,
      checkedOut: Boolean(attendanceRow?.checkOutAt),
      checkInLabel: attendanceRow?.checkInAt ? bnTime(attendanceRow.checkInAt) : null,
    },
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
