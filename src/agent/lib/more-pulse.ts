/**
 * "More" screen pulse — one aggregate feed for the native iOS More tab.
 *
 * Returns who the caller is (owner vs staff), a short list of things that need
 * their attention today (fines, missed intercom calls, unread notifications,
 * unanswered agent messages) and two progress meters (this week / this month).
 *
 * Design constraints (mirrors live-pulse):
 *  - Queries stay cheap: indexed fields, tight windows, small `take` limits,
 *    everything fanned out via Promise.all.
 *  - Every section is independently fault-tolerant: a failing aggregation
 *    contributes nothing instead of 500-ing the whole feed (`safe()` below).
 *  - Money is whole taka only (roundMoney); Prisma Decimals never leak out.
 *  - All copy is Bangla and staff-facing — never addresses anyone as "Boss".
 *
 * Date conventions in this codebase (verified against the writers):
 *  - AttendanceRecord.attendanceDate and AgentStaffTask.proposedFor store the
 *    Dhaka calendar date anchored at **UTC midnight** (`YYYY-MM-DDT00:00:00Z`)
 *    — see attendanceDateFor() in src/lib/attendance.ts and the office staff
 *    task writers in src/agent/lib/office-staff.ts.
 *  - createdAt-style columns are real instants, so "today" filters on them use
 *    the +06:00-anchored Dhaka day window (same as live-pulse).
 */
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { currentWeekStart } from '@/agent/lib/office-award'
import { computeStaffPerformance } from '@/agent/lib/office-performance'
import { getNotificationFeed } from '@/agent/lib/office-notifications'
import { resolveSessionStaff } from '@/agent/lib/office-staff'

export type MorePulseAlertKind = 'fine' | 'missed_call' | 'chat' | 'agent'

export type MorePulseAlert = {
  id: string
  kind: MorePulseAlertKind
  title: string
  detail: string | null
  /** Whole taka, or null when the alert has no money attached. */
  amount: number | null
  /** ISO timestamp the alert refers to (sort key, newest first). */
  at: string
}

export type MorePulseProgress = {
  /** Integer 0–100, or null when there is no data to score. */
  weeklyPct: number | null
  monthlyPct: number | null
  weeklyLabel: string
  monthlyLabel: string
}

export type MorePulseUser = {
  name: string
  isOwner: boolean
  businessAccess: string[]
  /** For the native profile header/avatar — null when the user has none set. */
  email: string | null
  phone: string | null
  profileImageUrl: string | null
}

export type MorePulse = {
  user: MorePulseUser
  alerts: MorePulseAlert[]
  progress: MorePulseProgress
}

const MAX_ALERTS = 10
const MAX_AGENT_ALERTS = 3
const INTERCOM_WINDOW_MS = 24 * 3600_000
const OWNER_OUTBOX_WINDOW_MS = 48 * 3600_000

// ── Dhaka date-window helpers ────────────────────────────────────────────────

/** Dhaka-local YYYY-MM-DD for an instant (en-CA gives ISO ordering). */
function dhakaYmd(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * Today's Asia/Dhaka (UTC+6, no DST) day window as a UTC [start, end) pair —
 * for REAL timestamps (createdAt etc.). Same approach as live-pulse.
 */
function dhakaTodayWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(`${dhakaYmd(now)}T00:00:00+06:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

/**
 * Today's Dhaka date as the UTC-midnight anchor used by @db.Date-style columns
 * (attendanceDate, proposedFor). NOT an instant — a calendar-date key.
 */
function dhakaTodayAnchor(now = new Date()): Date {
  return new Date(`${dhakaYmd(now)}T00:00:00Z`)
}

/**
 * Current Dhaka calendar month as UTC-midnight anchors [start, end) — for the
 * same date-key columns (proposedFor / attendanceDate).
 */
function dhakaMonthAnchorWindow(now = new Date()): { start: Date; end: Date } {
  const [y, m] = dhakaYmd(now).split('-').map(Number)
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  }
}

// ── Small formatting helpers ─────────────────────────────────────────────────

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']

/** 0-9 → Bangla numerals, for the staff-facing labels. */
function toBn(n: number): string {
  return String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)])
}

/** Truncate agent-message previews to roughly one line (~80 chars). */
function truncate(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Prisma Decimal | number | null → whole taka int, or null when absent/zero. */
function takaOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = roundMoney(Number(v))
  return n > 0 ? n : null
}

/**
 * Fault isolation: run one aggregation, fall back to `fallback` on ANY error.
 * A broken section must never 500 the whole More screen.
 */
async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Newest-first, capped at the contract's max of 10. */
function finalizeAlerts(alerts: MorePulseAlert[]): MorePulseAlert[] {
  return alerts
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_ALERTS)
}

/**
 * Blend of task completion and attendance punctuality (both 0–100). When only
 * one signal exists we use it alone; when neither exists → null.
 * pct = round(0.6 * taskCompletionRate + 0.4 * punctualityRate)
 */
function blendPct(taskCompletionRate: number | null, punctualityRate: number | null): number | null {
  if (taskCompletionRate != null && punctualityRate != null) {
    return Math.max(0, Math.min(100, Math.round(0.6 * taskCompletionRate + 0.4 * punctualityRate)))
  }
  if (taskCompletionRate != null) return Math.max(0, Math.min(100, Math.round(taskCompletionRate)))
  if (punctualityRate != null) return Math.max(0, Math.min(100, Math.round(punctualityRate)))
  return null
}

// ── Staff aggregations ───────────────────────────────────────────────────────

type StaffCtx = { staffId: string; userId: string; businessId: string }

/** Today's attendance fines + today's penalty proposals for this staff. */
async function staffFineAlerts(ctx: StaffCtx): Promise<MorePulseAlert[]> {
  const today = dhakaTodayWindow()
  const [record, proposals] = await Promise.all([
    // Attendance links to the login user, not AgentStaff: AttendanceRecord.userId
    // is User.id (the same id resolveSessionStaff matched on).
    prisma.attendanceRecord.findFirst({
      where: { userId: ctx.userId, businessId: ctx.businessId, attendanceDate: dhakaTodayAnchor() },
      select: {
        id: true,
        checkInAt: true,
        checkOutAt: true,
        lateMinutes: true,
        penaltyAmount: true,
        earlyLeavePenaltyAmount: true,
        noCheckoutFineAmount: true,
      },
    }),
    prisma.officeStaffProposal.findMany({
      where: {
        staffId: ctx.staffId,
        kind: 'penalty',
        status: { in: ['pending', 'approved'] },
        createdAt: { gte: today.start, lt: today.end },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, reason: true, amount: true, status: true, createdAt: true },
    }),
  ])

  const alerts: MorePulseAlert[] = []
  if (record) {
    const late = takaOrNull(record.penaltyAmount)
    if (late != null) {
      alerts.push({
        id: `att-late-${record.id}`,
        kind: 'fine',
        title: `লেট ফাইন — ${toBn(record.lateMinutes)} মিনিট দেরি`,
        detail: 'আজকের চেক-ইন দেরিতে হয়েছে',
        amount: late,
        at: record.checkInAt.toISOString(),
      })
    }
    const early = takaOrNull(record.earlyLeavePenaltyAmount)
    if (early != null) {
      alerts.push({
        id: `att-early-${record.id}`,
        kind: 'fine',
        title: 'আর্লি লিভ ফাইন',
        detail: 'অফিস সময় শেষ হওয়ার আগে চেক-আউট',
        amount: early,
        at: (record.checkOutAt ?? record.checkInAt).toISOString(),
      })
    }
    const noCheckout = takaOrNull(record.noCheckoutFineAmount)
    if (noCheckout != null) {
      alerts.push({
        id: `att-nco-${record.id}`,
        kind: 'fine',
        title: 'চেক-আউট না করার ফাইন',
        detail: 'চেক-ইন ছিল, কিন্তু চেক-আউট হয়নি',
        amount: noCheckout,
        at: record.checkInAt.toISOString(),
      })
    }
  }

  for (const p of proposals) {
    alerts.push({
      id: `prop-${p.id}`,
      kind: 'fine',
      title: p.status === 'approved' ? 'জরিমানা অনুমোদিত হয়েছে' : 'জরিমানা প্রস্তাব — অনুমোদনের অপেক্ষায়',
      detail: truncate(p.reason),
      amount: takaOrNull(p.amount),
      at: p.createdAt.toISOString(),
    })
  }
  return alerts
}

/** Intercom broadcasts (24h) this staff never played nor confirmed. */
async function staffMissedCallAlerts(ctx: StaffCtx): Promise<MorePulseAlert[]> {
  const rows = await prisma.officeIntercomBroadcast.findMany({
    where: {
      businessId: ctx.businessId,
      createdAt: { gte: new Date(Date.now() - INTERCOM_WINDOW_MS) },
      // Addressed to this staff (direct target or all-staff broadcast)…
      OR: [{ targetStaffId: ctx.staffId }, { targetStaffId: null }],
      // …and their own receipt shows it was never played nor confirmed.
      receipts: { some: { staffId: ctx.staffId, playedAt: null, confirmedAt: null } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, kind: true, createdAt: true },
  })

  return rows.map((r) => ({
    id: `itc-${r.id}`,
    kind: 'missed_call' as const,
    title: 'মিসড কল — অফিস ইন্টারকম',
    detail:
      r.kind === 'urgent'
        ? 'বসের জরুরি এলার্ট — এখনো শোনা হয়নি'
        : r.kind === 'call'
          ? 'লাইভ কল ধরা হয়নি'
          : 'ভয়েস মেসেজ এখনো শোনা হয়নি',
    amount: null,
    at: r.createdAt.toISOString(),
  }))
}

/** ONE rollup alert for unread in-app notifications (staff or owner bucket). */
async function unreadChatAlert(
  scope: { owner: true } | { owner: false; staffId: string },
  businessId: string,
): Promise<MorePulseAlert[]> {
  // Same lib the bell/feed uses; limit 10 is enough to find the latest unread.
  const feed = await getNotificationFeed(scope, businessId, 10)
  if (feed.unread <= 0) return []
  const latestUnread = feed.items.find((i) => !i.read)
  return [
    {
      id: `chat-${scope.owner ? 'owner' : scope.staffId}`,
      kind: 'chat',
      title: `${toBn(feed.unread)} টা নতুন নোটিফিকেশন`,
      detail: latestUnread ? truncate(latestUnread.title) : null,
      amount: null,
      at: latestUnread?.createdAt ?? new Date().toISOString(),
    },
  ]
}

/** Agent messages that demanded an ack this staff never gave (cap 3). */
async function staffAgentAlerts(ctx: StaffCtx): Promise<MorePulseAlert[]> {
  const rows = await prisma.agentOutbox.findMany({
    where: { staffId: ctx.staffId, requiresAck: true, acknowledgedAt: null },
    orderBy: { createdAt: 'desc' },
    take: MAX_AGENT_ALERTS,
    select: { id: true, content: true, createdAt: true },
  })
  return rows.map((r) => ({
    id: `agent-${r.id}`,
    kind: 'agent' as const,
    title: 'এজেন্টের মেসেজে সাড়া দেওয়া হয়নি',
    detail: truncate(r.content),
    amount: null,
    at: r.createdAt.toISOString(),
  }))
}

/** Staff progress: weekly completion + monthly 60/40 task-punctuality blend. */
async function staffProgress(ctx: StaffCtx): Promise<MorePulseProgress> {
  const month = dhakaMonthAnchorWindow()
  const [weeklyAll, monthTasks, monthAttendance] = await Promise.all([
    // Same weekly scorecard the office pages use (current Dhaka week,
    // Monday-anchored — see currentWeekStart in office-award.ts).
    safe([] as Awaited<ReturnType<typeof computeStaffPerformance>>, () =>
      computeStaffPerformance(ctx.businessId, currentWeekStart()),
    ),
    safe(null as { total: number; done: number } | null, async () => {
      const [total, done] = await Promise.all([
        prisma.agentStaffTask.count({
          where: { staffId: ctx.staffId, proposedFor: { gte: month.start, lt: month.end } },
        }),
        prisma.agentStaffTask.count({
          where: { staffId: ctx.staffId, proposedFor: { gte: month.start, lt: month.end }, status: 'done' },
        }),
      ])
      return { total, done }
    }),
    safe(null as { present: number; late: number } | null, async () => {
      const rows = await prisma.attendanceRecord.findMany({
        where: {
          userId: ctx.userId,
          businessId: ctx.businessId,
          attendanceDate: { gte: month.start, lt: month.end },
        },
        select: { lateMinutes: true },
        take: 40, // a month has ≤ 31 records; hard cap keeps it bounded
      })
      return { present: rows.length, late: rows.filter((r) => r.lateMinutes > 0).length }
    }),
  ])

  // Weekly: this staff's row from the shared scorecard → completion %.
  const mine = weeklyAll.find((p) => p.staffId === ctx.staffId)
  const weeklyPct =
    mine && mine.assigned > 0 ? Math.max(0, Math.min(100, Math.round((mine.done / mine.assigned) * 100))) : null
  const weeklyLabel = mine && mine.assigned > 0
    ? `${toBn(mine.done)}/${toBn(mine.assigned)} টাস্ক${mine.late > 0 ? ` · ${toBn(mine.late)} টা লেট` : ''}`
    : 'এই সপ্তাহে কোনো টাস্ক নেই'

  // Monthly: 60% task completion + 40% punctuality (late day = lateMinutes>0).
  const taskRate =
    monthTasks && monthTasks.total > 0 ? (monthTasks.done / monthTasks.total) * 100 : null
  const punctuality =
    monthAttendance && monthAttendance.present > 0
      ? 100 - Math.min(100, Math.round((monthAttendance.late / monthAttendance.present) * 100))
      : null
  const monthlyPct = blendPct(taskRate, punctuality)

  const monthlyParts: string[] = []
  if (monthTasks && monthTasks.total > 0) monthlyParts.push(`${toBn(monthTasks.done)}/${toBn(monthTasks.total)} টাস্ক`)
  if (monthAttendance && monthAttendance.present > 0) {
    monthlyParts.push(monthAttendance.late > 0 ? `${toBn(monthAttendance.late)} দিন লেট` : 'সব দিন সময়মতো')
  }
  const monthlyLabel = monthlyParts.length > 0 ? monthlyParts.join(' · ') : 'এ মাসে এখনো ডেটা নেই'

  return { weeklyPct, monthlyPct, weeklyLabel, monthlyLabel }
}

// ── Owner aggregations ───────────────────────────────────────────────────────

/** Pending penalty proposals → one rollup fine alert for the owner. */
async function ownerPenaltyAlert(businessId: string): Promise<MorePulseAlert[]> {
  const [count, latest] = await Promise.all([
    prisma.officeStaffProposal.count({
      where: { businessId, kind: 'penalty', status: 'pending' },
    }),
    prisma.officeStaffProposal.findFirst({
      where: { businessId, kind: 'penalty', status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, createdAt: true },
    }),
  ])
  if (count <= 0 || !latest) return []
  return [
    {
      id: `owner-penalty-${businessId}`,
      kind: 'fine',
      title: `${toBn(count)} টা জরিমানা প্রস্তাব অনুমোদনের অপেক্ষায়`,
      detail: truncate(latest.reason),
      amount: null,
      at: latest.createdAt.toISOString(),
    },
  ]
}

/** Staff who ignored ack-required agent messages (48h) → one rollup alert. */
async function ownerUnackedAgentAlert(): Promise<MorePulseAlert[]> {
  const rows = await prisma.agentOutbox.findMany({
    where: {
      requiresAck: true,
      acknowledgedAt: null,
      createdAt: { gte: new Date(Date.now() - OWNER_OUTBOX_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { staffId: true, staffName: true, createdAt: true },
  })
  if (rows.length === 0) return []
  const staffIds = new Set(rows.map((r) => r.staffId ?? 'unknown'))
  const latest = rows[0]
  return [
    {
      id: 'owner-unacked-agent',
      kind: 'agent',
      title: `${toBn(staffIds.size)} জন স্টাফ এজেন্টকে সাড়া দেয়নি`,
      detail: latest?.staffName ? `সর্বশেষ: ${latest.staffName}` : null,
      amount: null,
      at: (latest?.createdAt ?? new Date()).toISOString(),
    },
  ]
}

/** Owner progress: team weekly average + whole-team monthly completion. */
async function ownerProgress(businessId: string): Promise<MorePulseProgress> {
  const month = dhakaMonthAnchorWindow()
  const [weekly, monthTasks] = await Promise.all([
    safe([] as Awaited<ReturnType<typeof computeStaffPerformance>>, () =>
      computeStaffPerformance(businessId, currentWeekStart()),
    ),
    safe(null as { total: number; done: number } | null, async () => {
      const [total, done] = await Promise.all([
        prisma.agentStaffTask.count({
          where: { businessId, proposedFor: { gte: month.start, lt: month.end } },
        }),
        prisma.agentStaffTask.count({
          where: { businessId, proposedFor: { gte: month.start, lt: month.end }, status: 'done' },
        }),
      ])
      return { total, done }
    }),
  ])

  // Team weekly average: per-staff completion %, blended with on-time % when
  // that staff had deadline-bearing tasks (same 60/40 weighting as staff view).
  const scored = weekly.filter((p) => p.assigned > 0)
  let weeklyPct: number | null = null
  if (scored.length > 0) {
    const perStaff = scored.map((p) => blendPct((p.done / p.assigned) * 100, p.onTimeRate) ?? 0)
    weeklyPct = Math.max(
      0,
      Math.min(100, Math.round(perStaff.reduce((a, b) => a + b, 0) / perStaff.length)),
    )
  }
  const weeklyLabel = scored.length > 0 ? `টিম গড় · ${toBn(scored.length)} স্টাফ` : 'এই সপ্তাহে টিমের ডেটা নেই'

  const monthlyPct =
    monthTasks && monthTasks.total > 0
      ? Math.max(0, Math.min(100, Math.round((monthTasks.done / monthTasks.total) * 100)))
      : null
  const monthlyLabel =
    monthTasks && monthTasks.total > 0
      ? `${toBn(monthTasks.done)}/${toBn(monthTasks.total)} টাস্ক · পুরো টিম`
      : 'এ মাসে এখনো টাস্ক নেই'

  return { weeklyPct, monthlyPct, weeklyLabel, monthlyLabel }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const EMPTY_PROGRESS: MorePulseProgress = {
  weeklyPct: null,
  monthlyPct: null,
  weeklyLabel: 'এই সপ্তাহে ডেটা নেই',
  monthlyLabel: 'এ মাসে ডেটা নেই',
}

export async function buildMorePulse(args: {
  /** token.sub — User.id of the caller. */
  userId: string
  /** token.name (may be missing on old tokens). */
  name: string
  isOwner: boolean
  businessAccess: string[]
  /** Owner-only: which business to aggregate (validated by the route). */
  ownerBusinessId: string
}): Promise<MorePulse> {
  // Contact + avatar aren't in the JWT — one cheap indexed read; the native
  // profile header degrades to initials/placeholder if it fails.
  const contact = await safe(
    null as { email: string | null; phone: string | null; profileImageUrl: string | null } | null,
    () =>
      prisma.user.findUnique({
        where: { id: args.userId },
        select: { email: true, phone: true, profileImageUrl: true },
      }),
  )
  const user: MorePulseUser = {
    name: args.name,
    isOwner: args.isOwner,
    businessAccess: args.businessAccess,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    profileImageUrl: contact?.profileImageUrl ?? null,
  }

  if (args.isOwner) {
    // Owner view — rollups across the selected business.
    const businessId = args.ownerBusinessId
    const [chat, penalty, unacked, progress] = await Promise.all([
      safe([] as MorePulseAlert[], () => unreadChatAlert({ owner: true }, businessId)),
      safe([] as MorePulseAlert[], () => ownerPenaltyAlert(businessId)),
      safe([] as MorePulseAlert[], () => ownerUnackedAgentAlert()),
      safe(EMPTY_PROGRESS, () => ownerProgress(businessId)),
    ])
    return { user, alerts: finalizeAlerts([...chat, ...penalty, ...unacked]), progress }
  }

  // Staff view — needs an active AgentStaff row linked to this login.
  const staff = await safe(null as Awaited<ReturnType<typeof resolveSessionStaff>>, () =>
    resolveSessionStaff(args.userId),
  )
  if (!staff) {
    // Logged-in user with neither owner role nor a staff link (e.g. plain ERP
    // account): empty-but-valid payload so the More screen still renders.
    return { user, alerts: [], progress: EMPTY_PROGRESS }
  }

  const ctx: StaffCtx = { staffId: staff.id, userId: args.userId, businessId: staff.businessId }
  const [fines, missed, chat, agent, progress] = await Promise.all([
    safe([] as MorePulseAlert[], () => staffFineAlerts(ctx)),
    safe([] as MorePulseAlert[], () => staffMissedCallAlerts(ctx)),
    safe([] as MorePulseAlert[], () => unreadChatAlert({ owner: false, staffId: staff.id }, staff.businessId)),
    safe([] as MorePulseAlert[], () => staffAgentAlerts(ctx)),
    safe(EMPTY_PROGRESS, () => staffProgress(ctx)),
  ])

  return { user, alerts: finalizeAlerts([...fines, ...missed, ...chat, ...agent]), progress }
}
