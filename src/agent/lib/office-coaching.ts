/**
 * P3 — Performance-trend coaching + shift handover.
 *
 * Two read-only, rule-based helpers (no extra LLM call, mirroring the proposal
 * builder's design) layered on top of the existing task data + the Phase-3
 * performance scorecard:
 *
 *   1. computeStaffTrend  — compares this Dhaka week vs last week per staff and
 *      turns the delta into a short, warm Bangla coaching line (improving /
 *      slipping / steady, plus the one thing to focus on).
 *   2. buildShiftHandover — an end-of-day handover the next shift (or tomorrow's
 *      proposal) can read at a glance: what closed today, what's still open, what
 *      should carry over, who needs a follow-up nudge, and today's standout.
 *
 * Neither mutates a task or touches money. Safe to call on any page load / tool.
 */
import { prisma } from '@/lib/prisma'
import { currentWeekStart } from '@/agent/lib/office-award'
import { computeStaffPerformance, type StaffPerformance } from '@/agent/lib/office-performance'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

/** Dhaka-local YYYY-MM-DD for the given instant (defaults to now). */
function dhakaYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(now)
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00+06:00`)
  d.setUTCDate(d.getUTCDate() + days)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

// ── Performance-trend coaching ──────────────────────────────────────────────

export type TrendDirection = 'up' | 'down' | 'flat'

export type StaffTrend = {
  staffId: string
  staffName: string
  direction: TrendDirection
  /** This week's composite score minus last week's. */
  deltaScore: number
  /** This week's finished count minus last week's. */
  deltaDone: number
  thisWeek: { done: number; onTimeRate: number | null; redo: number; score: number }
  lastWeek: { done: number; onTimeRate: number | null; redo: number; score: number }
  /** One warm, actionable Bangla coaching line for this staff. */
  coachLine: string
}

function slim(p: StaffPerformance | undefined): { done: number; onTimeRate: number | null; redo: number; score: number } {
  return { done: p?.done ?? 0, onTimeRate: p?.onTimeRate ?? null, redo: p?.redo ?? 0, score: p?.score ?? 0 }
}

/**
 * Build the one coaching line. Priority order: a clear quality/punctuality
 * problem is worth more than raw momentum, so we surface that first; otherwise
 * we reflect the trend. Always ends on an encouraging, forward-looking note.
 */
function buildCoachLine(name: string, dir: TrendDirection, tw: StaffTrend['thisWeek'], deltaDone: number): string {
  // Quality first: rework is the most expensive signal.
  if (tw.redo >= 2) {
    return `🛠 *${name}* — এ সপ্তাহে ${bn(tw.redo)}বার redo লেগেছে। আগে একবারে ঠিকঠাক শেষ করার দিকে নজর দিলে স্কোর দ্রুত উঠবে।`
  }
  // Punctuality next.
  if (tw.onTimeRate !== null && tw.onTimeRate < 60 && tw.done > 0) {
    return `⏰ *${name}* — সময়মতো শেষের হার ${bn(tw.onTimeRate)}%। deadline-এর দিকে একটু খেয়াল রাখলেই বড় পার্থক্য হবে।`
  }
  if (dir === 'up') {
    const more = deltaDone > 0 ? ` (${bn(deltaDone)}টি বেশি কাজ শেষ)` : ''
    return `📈 *${name}* — গত সপ্তাহের চেয়ে ভালো করছে${more}। এভাবেই ধরে রাখো, দারুণ হচ্ছে।`
  }
  if (dir === 'down') {
    const less = deltaDone < 0 ? ` (${bn(Math.abs(deltaDone))}টি কম)` : ''
    return `🔻 *${name}* — এ সপ্তাহে একটু পিছিয়ে আছে${less}। চিন্তা নেই — আজ থেকেই একটা-একটা করে গুছিয়ে নিলেই ফিরে আসবে।`
  }
  // Flat.
  if (tw.done === 0) {
    return `🌱 *${name}* — এখনো এ সপ্তাহে কাজ শেষ হয়নি। ছোট একটা কাজ দিয়ে শুরু করলেই গতি আসবে।`
  }
  return `✅ *${name}* — স্থিতিশীল পারফরম্যান্স (${bn(tw.done)}টি কাজ শেষ)। ধারাবাহিকতাই শক্তি, এভাবেই চলুক।`
}

function classify(deltaScore: number): TrendDirection {
  if (deltaScore >= 5) return 'up'
  if (deltaScore <= -5) return 'down'
  return 'flat'
}

/**
 * Per-staff week-over-week trend + a coaching line. Sorted by momentum
 * (biggest improvers first, then biggest slippers) so the owner sees movement.
 */
export async function computeStaffTrend(
  businessId = 'ALMA_LIFESTYLE',
  weekStart: Date = currentWeekStart(),
): Promise<StaffTrend[]> {
  const thisStart = weekStart
  const lastStart = new Date(thisStart.getTime() - 7 * 24 * 60 * 60 * 1000)

  const [thisWeek, lastWeek] = await Promise.all([
    computeStaffPerformance(businessId, thisStart),
    computeStaffPerformance(businessId, lastStart),
  ])

  const lastById = new Map(lastWeek.map((p) => [p.staffId, p]))
  const seen = new Set<string>()
  const trends: StaffTrend[] = []

  for (const tw of thisWeek) {
    seen.add(tw.staffId)
    const lw = lastById.get(tw.staffId)
    const deltaScore = (tw.score ?? 0) - (lw?.score ?? 0)
    const deltaDone = (tw.done ?? 0) - (lw?.done ?? 0)
    const dir = classify(deltaScore)
    const twSlim = slim(tw)
    trends.push({
      staffId: tw.staffId,
      staffName: tw.staffName,
      direction: dir,
      deltaScore,
      deltaDone,
      thisWeek: twSlim,
      lastWeek: slim(lw),
      coachLine: buildCoachLine(tw.staffName, dir, twSlim, deltaDone),
    })
  }

  // Staff who worked last week but have nothing this week — flag the drop-off.
  for (const lw of lastWeek) {
    if (seen.has(lw.staffId)) continue
    const twSlim = { done: 0, onTimeRate: null, redo: 0, score: 0 }
    trends.push({
      staffId: lw.staffId,
      staffName: lw.staffName,
      direction: 'down',
      deltaScore: -(lw.score ?? 0),
      deltaDone: -(lw.done ?? 0),
      thisWeek: twSlim,
      lastWeek: slim(lw),
      coachLine: buildCoachLine(lw.staffName, 'down', twSlim, -(lw.done ?? 0)),
    })
  }

  return trends.sort((a, b) => b.deltaScore - a.deltaScore)
}

// ── Shift handover ──────────────────────────────────────────────────────────

export type HandoverStaffLine = { staffId: string; staffName: string; done: number; open: number }

export type ShiftHandover = {
  dateYmd: string
  doneToday: number
  stillOpen: number
  carryOver: Array<{ title: string; staffName: string; overdue: boolean }>
  followUps: Array<{ staffName: string; title: string; ageDays: number }>
  topPerformer: { staffName: string; done: number } | null
  perStaff: HandoverStaffLine[]
  /** Plain-Bangla handover text the next shift / tomorrow's proposal can read. */
  summaryBangla: string
}

type HandoverTaskRow = {
  staffId: string
  title: string
  status: string
  proposedFor: Date
  dueAt: Date | null
  completedAt: Date | null
  staff: { name: string | null } | null
}

const OPEN_STATUSES = new Set(['proposed', 'sent', 'active', 'in_progress'])

/**
 * Build the end-of-day handover for `dateYmd` (defaults to today, Dhaka). Looks
 * at today's tasks for done/open counts, and at the last few days for tasks that
 * are still open past their day (the follow-up nudges) so nothing silently rots.
 */
export async function buildShiftHandover(
  businessId = 'ALMA_LIFESTYLE',
  dateYmd: string = dhakaYmd(),
  lookbackDays = 4,
): Promise<ShiftHandover> {
  const dayStart = new Date(`${dateYmd}T00:00:00+06:00`)
  const dayEnd = new Date(`${dateYmd}T23:59:59+06:00`)
  const lookbackStart = new Date(`${addDaysYmd(dateYmd, -lookbackDays)}T00:00:00+06:00`)
  const nowMs = Date.now()

  const rows = (await prisma.agentStaffTask.findMany({
    where: { businessId, proposedFor: { gte: lookbackStart, lte: dayEnd } },
    select: {
      staffId: true,
      title: true,
      status: true,
      proposedFor: true,
      dueAt: true,
      completedAt: true,
      staff: { select: { name: true } },
    },
    orderBy: { proposedFor: 'asc' },
  })) as HandoverTaskRow[]

  const perStaffMap = new Map<string, HandoverStaffLine>()
  const carryOver: ShiftHandover['carryOver'] = []
  const followUps: ShiftHandover['followUps'] = []
  let doneToday = 0
  let stillOpen = 0

  const ymdOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)

  for (const r of rows) {
    const name = r.staff?.name ?? 'অজানা'
    const onDay = ymdOf(r.proposedFor) === dateYmd
    const isOpen = OPEN_STATUSES.has(r.status)
    const isDone = r.status === 'done'

    if (onDay) {
      const line = perStaffMap.get(r.staffId) ?? { staffId: r.staffId, staffName: name, done: 0, open: 0 }
      if (isDone) {
        line.done += 1
        doneToday += 1
      } else if (isOpen) {
        line.open += 1
        stillOpen += 1
        const overdue = !!r.dueAt && r.dueAt.getTime() < nowMs
        carryOver.push({ title: r.title, staffName: name, overdue })
      }
      perStaffMap.set(r.staffId, line)
    } else if (isOpen) {
      // Open task from an earlier day → a follow-up nudge.
      const ageDays = Math.max(1, Math.round((dayStart.getTime() - r.proposedFor.getTime()) / 86_400_000))
      followUps.push({ staffName: name, title: r.title, ageDays })
    }
  }

  followUps.sort((a, b) => b.ageDays - a.ageDays)
  // Keep the carry-over / follow-up lists readable.
  const carryTop = carryOver.slice(0, 8)
  const followTop = followUps.slice(0, 6)

  const perStaff = [...perStaffMap.values()].sort((a, b) => b.done - a.done || b.open - a.open)
  const topPerformer = perStaff.find((s) => s.done > 0) ?? null

  // ── Compose the Bangla handover ──
  const lines: string[] = []
  lines.push(`📋 *শিফট হ্যান্ডওভার — ${dateYmd}*`)
  lines.push('')
  lines.push(`✅ আজ শেষ: ${bn(doneToday)}টি · 🔄 এখনো খোলা: ${bn(stillOpen)}টি`)

  if (topPerformer) {
    lines.push(`🏅 আজকের সেরা: *${topPerformer.staffName}* (${bn(topPerformer.done)}টি শেষ)`)
  }

  if (carryTop.length) {
    lines.push('')
    lines.push('➡️ *আগামীকালের জন্য ক্যারি-ওভার:*')
    for (const c of carryTop) {
      lines.push(`• ${c.overdue ? '🔴 ' : ''}${c.title} — ${c.staffName}${c.overdue ? ' (deadline পার)' : ''}`)
    }
  }

  if (followTop.length) {
    lines.push('')
    lines.push('⏳ *ফলো-আপ দরকার (পুরোনো বকেয়া):*')
    for (const f of followTop) {
      lines.push(`• ${f.title} — ${f.staffName} (${bn(f.ageDays)} দিন ধরে খোলা)`)
    }
  }

  if (!carryTop.length && !followTop.length) {
    lines.push('')
    lines.push('🎉 কোনো বকেয়া নেই — সব গোছানো, পরিষ্কার হ্যান্ডওভার।')
  }

  return {
    dateYmd,
    doneToday,
    stillOpen,
    carryOver: carryTop,
    followUps: followTop,
    topPerformer: topPerformer ? { staffName: topPerformer.staffName, done: topPerformer.done } : null,
    perStaff,
    summaryBangla: lines.join('\n'),
  }
}
