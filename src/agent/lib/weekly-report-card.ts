/**
 * Feature D — Weekly staff report-card + auto-coaching ("দলকে ধরে রাখা / উন্নতি").
 *
 * The pieces to judge the team already exist (office-performance scorecard +
 * office-coaching week-over-week trend + coaching lines), but they were only ever
 * surfaced ON DEMAND (get_shift_handover). Nothing delivered the owner a regular,
 * consolidated "how did my team do this week, and who needs a word" card.
 *
 * This module adds that missing surface:
 *   1. buildWeeklyReportCard — a pure-ish (read-only) rollup for ONE Dhaka week:
 *      team totals, per-staff score + trend + a warm coaching line, the standout,
 *      the biggest improver, and who needs attention. Returns ready-to-show Bangla.
 *   2. runWeeklyReportCardSend — the AUTO part: once a week (Monday morning, Dhaka)
 *      push the just-finished week's card to the owner. Idempotent (KV-deduped per
 *      week), never re-fires, and silently skips a week with no staff activity.
 *
 * Safety: read-only over task data + the existing scorecard. It NEVER mutates a
 * task, assigns work, or touches money — it only summarises and coaches. No DB
 * migration; the once-per-week guard lives in agent_kv_settings.
 */
import { prisma } from '@/lib/prisma'
import { currentWeekStart } from '@/agent/lib/office-award'
import { computeStaffPerformance, type StaffPerformance } from '@/agent/lib/office-performance'
import { computeStaffTrend, type StaffTrend } from '@/agent/lib/office-coaching'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const WEEKLY_CARD_KEY_PREFIX = 'weekly_report_card:'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

/** YYYY-MM-DD for a Date, in Dhaka. */
function ymd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

/** "9 Jun – 15 Jun" style label for a week given its Monday start. */
function weekLabel(weekStart: Date): string {
  const end = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' }).format(d)
  return `${fmt(weekStart)} – ${fmt(end)}`
}

/** Day-of-week (0=Sun..6=Sat) in Dhaka for the given instant. */
function dhakaDow(now: Date): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' }).format(now)
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 1
}

export interface WeeklyReportCardStaff {
  staffId: string
  staffName: string
  score: number
  done: number
  assigned: number
  onTimeRate: number | null
  redo: number
  escalated: number
  direction: StaffTrend['direction']
  deltaScore: number
  coachLine: string
}

export interface WeeklyReportCard {
  weekStartYmd: string
  weekLabel: string
  staffCount: number
  totals: { assigned: number; done: number; onTimeRate: number | null; redo: number; escalated: number }
  perStaff: WeeklyReportCardStaff[]
  topPerformer: { staffName: string; score: number; done: number } | null
  biggestImprover: { staffName: string; deltaScore: number } | null
  needsAttention: Array<{ staffName: string; reason: string }>
  /** Ready-to-show owner-facing Bangla report-card. */
  summaryBangla: string
}

function attentionReason(p: StaffPerformance, t: StaffTrend | undefined): string | null {
  if (p.redo >= 2) return `${bn(p.redo)}বার redo`
  if (p.onTimeRate !== null && p.onTimeRate < 60 && p.done > 0) return `সময়মতো মাত্র ${bn(p.onTimeRate)}%`
  if (t?.direction === 'down') return 'গত সপ্তাহের চেয়ে পিছিয়ে'
  if (p.done === 0 && p.assigned > 0) return 'কোনো কাজ শেষ হয়নি'
  return null
}

/**
 * Build the consolidated weekly report-card for one Dhaka week. `weekStart`
 * defaults to the JUST-FINISHED week (last Monday), which is what the Monday
 * auto-send reports on. Read-only.
 */
export async function buildWeeklyReportCard(opts: {
  businessId?: string
  /** Monday anchoring the week to report. Defaults to the previous (finished) week. */
  weekStart?: Date
} = {}): Promise<WeeklyReportCard> {
  const businessId = opts.businessId ?? 'ALMA_LIFESTYLE'
  const weekStart = opts.weekStart ?? new Date(currentWeekStart().getTime() - 7 * 24 * 60 * 60 * 1000)

  const [perf, trends] = await Promise.all([
    computeStaffPerformance(businessId, weekStart),
    computeStaffTrend(businessId, weekStart),
  ])
  const trendById = new Map(trends.map((t) => [t.staffId, t]))

  const totals = perf.reduce(
    (acc, p) => {
      acc.assigned += p.assigned
      acc.done += p.done
      acc.redo += p.redo
      acc.escalated += p.escalated
      acc.onTime += p.onTime
      acc.late += p.late
      return acc
    },
    { assigned: 0, done: 0, redo: 0, escalated: 0, onTime: 0, late: 0 },
  )
  const withDue = totals.onTime + totals.late
  const teamOnTimeRate = withDue > 0 ? Math.round((totals.onTime / withDue) * 100) : null

  const perStaff: WeeklyReportCardStaff[] = perf.map((p) => {
    const t = trendById.get(p.staffId)
    return {
      staffId: p.staffId,
      staffName: p.staffName,
      score: p.score,
      done: p.done,
      assigned: p.assigned,
      onTimeRate: p.onTimeRate,
      redo: p.redo,
      escalated: p.escalated,
      direction: t?.direction ?? 'flat',
      deltaScore: t?.deltaScore ?? 0,
      coachLine: t?.coachLine ?? '',
    }
  })

  const topPerformer = perStaff.find((s) => s.score > 0 || s.done > 0) ?? null
  const improverT = [...trends].sort((a, b) => b.deltaScore - a.deltaScore)[0]
  const biggestImprover = improverT && improverT.deltaScore > 0 ? { staffName: improverT.staffName, deltaScore: improverT.deltaScore } : null

  const needsAttention: WeeklyReportCard['needsAttention'] = []
  for (const p of perf) {
    const reason = attentionReason(p, trendById.get(p.staffId))
    if (reason) needsAttention.push({ staffName: p.staffName, reason })
  }

  // ── Compose owner-facing Bangla ──
  const lines: string[] = []
  lines.push(`📊 *সাপ্তাহিক স্টাফ রিপোর্ট-কার্ড — ${weekLabel(weekStart)}*`)
  lines.push('')
  lines.push(
    `দল: ${bn(perStaff.length)} জন · কাজ দেওয়া ${bn(totals.assigned)}টি · শেষ ${bn(totals.done)}টি` +
      (teamOnTimeRate !== null ? ` · সময়মতো ${bn(teamOnTimeRate)}%` : ''),
  )

  if (topPerformer && (topPerformer.score > 0 || topPerformer.done > 0)) {
    lines.push(`🥇 সপ্তাহের সেরা: *${topPerformer.staffName}* (স্কোর ${bn(topPerformer.score)}, ${bn(topPerformer.done)}টি শেষ)`)
  }
  if (biggestImprover) {
    lines.push(`📈 সবচেয়ে বেশি উন্নতি: *${biggestImprover.staffName}* (+${bn(biggestImprover.deltaScore)} স্কোর)`)
  }

  const coachable = perStaff.filter((s) => s.coachLine && (s.done > 0 || s.assigned > 0))
  if (coachable.length) {
    lines.push('')
    lines.push('🎯 *এই সপ্তাহের কোচিং:*')
    for (const s of coachable.slice(0, 8)) lines.push(s.coachLine)
  }

  if (needsAttention.length) {
    lines.push('')
    lines.push('👀 *একটু নজর দরকার:*')
    for (const a of needsAttention.slice(0, 6)) lines.push(`• ${a.staffName} — ${a.reason}`)
  } else if (perStaff.length) {
    lines.push('')
    lines.push('✅ এই সপ্তাহে কারো বড় সমস্যা নেই — দল গোছানো আছে, মাশাআল্লাহ।')
  }

  return {
    weekStartYmd: ymd(weekStart),
    weekLabel: weekLabel(weekStart),
    staffCount: perStaff.length,
    totals: { assigned: totals.assigned, done: totals.done, onTimeRate: teamOnTimeRate, redo: totals.redo, escalated: totals.escalated },
    perStaff,
    topPerformer: topPerformer ? { staffName: topPerformer.staffName, score: topPerformer.score, done: topPerformer.done } : null,
    biggestImprover,
    needsAttention,
    summaryBangla: lines.join('\n'),
  }
}

export interface WeeklyCardSendResult {
  sent: boolean
  detail: string
  weekStartYmd?: string
  staffCount?: number
}

/**
 * AUTO weekly delivery. Runs from the day-start sequence; only fires on Monday
 * (Dhaka), once per week, for the just-finished week. Idempotent via a KV guard
 * keyed on the reported week's Monday. `force` skips the Monday gate (for the
 * owner-facing "send it now" path / tests). Best-effort — never throws.
 */
export async function runWeeklyReportCardSend(opts: {
  businessId?: string
  now?: Date
  force?: boolean
} = {}): Promise<WeeklyCardSendResult> {
  try {
    const businessId = opts.businessId ?? 'ALMA_LIFESTYLE'
    const now = opts.now ?? new Date()

    // Gate: only the Monday-morning auto-run delivers (the week just closed).
    if (!opts.force && dhakaDow(now) !== 1) {
      return { sent: false, detail: 'not_monday' }
    }

    const card = await buildWeeklyReportCard({ businessId })

    // A week with no staff activity → nothing worth pinging about.
    if (card.totals.assigned === 0) {
      return { sent: false, detail: 'no_activity', weekStartYmd: card.weekStartYmd, staffCount: 0 }
    }

    const key = `${WEEKLY_CARD_KEY_PREFIX}${businessId}:${card.weekStartYmd}`
    const existing = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    if (existing?.value) {
      return { sent: false, detail: 'already_sent', weekStartYmd: card.weekStartYmd, staffCount: card.staffCount }
    }

    await notifyOwner({
      tier: 1,
      title: '📊 সাপ্তাহিক স্টাফ রিপোর্ট-কার্ড',
      message: card.summaryBangla,
      category: 'report',
    }).catch(() => {})

    await prisma.agentKvSetting.upsert({
      where: { key },
      create: { key, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })

    return { sent: true, detail: 'sent', weekStartYmd: card.weekStartYmd, staffCount: card.staffCount }
  } catch (err) {
    return { sent: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
