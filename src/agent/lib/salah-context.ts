/**
 * Shared salah accountability logic — used by get_salah_status tool and core.ts prompt injection.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import {
  isOwnerConfirmed,
  isEffectivelyDone,
  isPhantomSalahConfirmation,
} from '@/agent/lib/salah-resolve'
import type { SalahContext } from '@/agent/lib/system-prompt'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const WAQTS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const
export type Waqt = (typeof WAQTS)[number]

export type WaqtSummary = {
  date: string
  waqt: string
  status: string
  windowStart: Date
  windowEnd: Date
  confirmedAt: Date | null
  isOverdue: boolean
  isMissed: boolean
  /** Window has not started yet — always true for future waqts regardless of DB status */
  notYetDue: boolean
  /** confirmedAt before windowStart (bad LLM/auto-mark) */
  isPhantom: boolean
  /** Safe for "পড়েছেন" / done lists */
  effectivelyDone: boolean
}

async function loadDayRecords(dateYmd: string) {
  return db.agentSalahRecord.findMany({
    where: { date: dhakaMidnightUtc(dateYmd) },
    orderBy: { windowStart: 'asc' },
  }) as Promise<Array<{
    waqt: string
    status: string
    windowStart: Date
    windowEnd: Date
    remindersSent: number
    confirmedAt: Date | null
  }>>
}

export function summarizeWaqts(
  dateYmd: string,
  records: Array<{ waqt: string; status: string; windowStart: Date; windowEnd: Date; confirmedAt?: Date | null }>,
  now = new Date(),
): WaqtSummary[] {
  return WAQTS.map((waqt) => {
    const r = records.find((x) => x.waqt === waqt)
    if (!r) {
      return {
        date: dateYmd,
        waqt,
        status: 'not_scheduled',
        windowStart: now,
        windowEnd: now,
        confirmedAt: null,
        isOverdue: false,
        isMissed: false,
        notYetDue: true,
        isPhantom: false,
        effectivelyDone: false,
      }
    }
    const windowStart = new Date(r.windowStart)
    const pastWindowStart = now >= windowStart
    const pastWindowEnd = now > new Date(r.windowEnd)
    const phantom = isPhantomSalahConfirmation(r, windowStart)
    const notYetDue = !pastWindowStart
    const effectivelyDone = isEffectivelyDone(
      { status: r.status, confirmedAt: r.confirmedAt, windowStart: r.windowStart },
      now,
    )
    const isOverdue =
      pastWindowStart && !notYetDue && !effectivelyDone && (r.status === 'pending' || phantom)
    const isMissed =
      pastWindowEnd && !effectivelyDone && (r.status === 'pending' || phantom)
    return {
      date: dateYmd,
      waqt: r.waqt,
      status: r.status,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      confirmedAt: r.confirmedAt ?? null,
      isOverdue,
      isMissed,
      notYetDue,
      isPhantom: phantom,
      effectivelyDone,
    }
  })
}

/** Waqts the agent should ask about — NOT future prayers whose time hasn't come. */
export function pickAccountableWaqts(today: WaqtSummary[], yesterday: WaqtSummary[]): WaqtSummary[] {
  const needsAccountability = (s: WaqtSummary) => {
    if (s.notYetDue) return false
    if (s.effectivelyDone) return false
    if (s.status === 'missed' || s.isMissed) return true
    return s.isOverdue || s.isPhantom
  }
  return [
    ...yesterday.filter(needsAccountability),
    ...today.filter(needsAccountability),
  ]
}

export async function loadSalahAccountabilityContext(
  now = new Date(),
  userMessage = '',
): Promise<SalahContext | undefined> {
  if (userMessage && isPrayerTimeInquiry(userMessage) && !isSalahStatusInquiry(userMessage)) {
    return undefined
  }
  try {
    const todayYmd = todayYmdDhaka(now)
    const yesterdayYmd = addDaysYmd(todayYmd, -1)

    const [todayRecords, yesterdayRecords] = await Promise.all([
      loadDayRecords(todayYmd),
      loadDayRecords(yesterdayYmd),
    ])

    const todaySummary = summarizeWaqts(todayYmd, todayRecords, now)
    const yesterdaySummary = summarizeWaqts(yesterdayYmd, yesterdayRecords, now)
    // Suppress accountability for any waqt the owner has actively snoozed
    // ("পরে পড়বো" button / request_salah_delay → salah_overrides.delay_until in
    // the future). Without this the agent kept nagging about a waqt the owner
    // already deferred — the chat went jumbled/contradictory (owner report).
    const activeDelays = await db.agentSalahOverride.findMany({
      where: { delayUntil: { gt: now } },
      select: { waqt: true, date: true },
    }) as Array<{ waqt: string | null; date: Date | null }>
    const delayedKeys = new Set(
      activeDelays
        .filter((o) => o.waqt && o.date)
        .map((o) => `${todayYmdDhaka(new Date(o.date!))}:${o.waqt}`),
    )
    const isDelayed = (s: WaqtSummary) => delayedKeys.has(`${s.date}:${s.waqt}`)

    const accountable = pickAccountableWaqts(todaySummary, yesterdaySummary).filter((s) => !isDelayed(s))
    const statusInquiry = Boolean(userMessage && isSalahStatusInquiry(userMessage))

    if (accountable.length === 0 && !statusInquiry) return undefined

    const pendingWaqts = accountable.map((s) => ({
      waqt: s.date === yesterdayYmd ? `${s.waqt} (গতকাল)` : s.waqt,
      isOverdue: s.isOverdue,
      isMissed: s.isMissed || s.status === 'missed',
    }))

    if (statusInquiry) {
      const upcomingToday = todaySummary.filter((s) => s.notYetDue).map((s) => s.waqt)
      const doneToday = todaySummary.filter((s) => s.effectivelyDone).map((s) => s.waqt)

      return {
        pendingWaqts,
        statusSummary: {
          doneToday,
          upcomingToday,
          note:
            'upcomingToday = সময় এখনো হয়নি — "পড়েছেন" বলবেন না। get_salah_status দিয়ে DB যাচাই করুন।',
        },
      }
    }

    if (pendingWaqts.length === 0) return undefined

    return { pendingWaqts }
  } catch {
    return undefined
  }
}
