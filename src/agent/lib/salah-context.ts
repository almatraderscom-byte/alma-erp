/**
 * Shared salah accountability logic — used by get_salah_status tool and core.ts prompt injection.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { isPrayerTimeInquiry, isSalahStatusInquiry } from '@/agent/lib/salah-times'
import { isOwnerConfirmed } from '@/agent/lib/salah-resolve'
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
  notYetDue: boolean
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
      }
    }
    const pastWindowStart = now > new Date(r.windowStart)
    const pastWindowEnd = now > new Date(r.windowEnd)
    const isOverdue = pastWindowStart && r.status === 'pending' && !r.confirmedAt
    const isMissed = pastWindowEnd && r.status === 'pending' && !r.confirmedAt
    return {
      date: dateYmd,
      waqt: r.waqt,
      status: r.status,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      confirmedAt: r.confirmedAt ?? null,
      isOverdue,
      isMissed,
      notYetDue: r.status === 'pending' && !pastWindowStart,
    }
  })
}

/** Waqts the agent should ask about — NOT future prayers whose time hasn't come. */
export function pickAccountableWaqts(today: WaqtSummary[], yesterday: WaqtSummary[]): WaqtSummary[] {
  const needsAccountability = (s: WaqtSummary) => {
    if (isOwnerConfirmed({ status: s.status, confirmedAt: s.confirmedAt })) return false
    if (s.status === 'missed' || s.isMissed) return true
    return s.status === 'pending' && s.isOverdue
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
    const accountable = pickAccountableWaqts(todaySummary, yesterdaySummary)
    const statusInquiry = Boolean(userMessage && isSalahStatusInquiry(userMessage))

    if (accountable.length === 0 && !statusInquiry) return undefined

    const pendingWaqts = accountable.map((s) => ({
      waqt: s.date === yesterdayYmd ? `${s.waqt} (গতকাল)` : s.waqt,
      isOverdue: s.isOverdue,
      isMissed: s.isMissed || s.status === 'missed',
    }))

    if (statusInquiry) {
      const upcomingToday = todaySummary
        .filter((s) => s.notYetDue && !isOwnerConfirmed({ status: s.status, confirmedAt: s.confirmedAt }))
        .map((s) => s.waqt)
      const doneToday = todaySummary
        .filter((s) => isOwnerConfirmed({ status: s.status, confirmedAt: s.confirmedAt }))
        .map((s) => s.waqt)

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
