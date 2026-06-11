/**
 * Shared salah accountability logic — used by get_salah_status tool and core.ts prompt injection.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { isPrayerTimeInquiry } from '@/agent/lib/salah-times'
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
  records: Array<{ waqt: string; status: string; windowStart: Date; windowEnd: Date }>,
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
        isOverdue: false,
        isMissed: false,
        notYetDue: true,
      }
    }
    const pastWindowStart = now > new Date(r.windowStart)
    const pastWindowEnd = now > new Date(r.windowEnd)
    const isOverdue = pastWindowStart && r.status === 'pending'
    const isMissed = pastWindowEnd && r.status === 'pending'
    return {
      date: dateYmd,
      waqt: r.waqt,
      status: r.status,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      isOverdue,
      isMissed,
      notYetDue: r.status === 'pending' && !pastWindowStart,
    }
  })
}

/** Waqts the agent should ask about — NOT future prayers whose time hasn't come. */
export function pickAccountableWaqts(today: WaqtSummary[], yesterday: WaqtSummary[]): WaqtSummary[] {
  const fromYesterday = yesterday.filter(
    (s) => s.status === 'pending' || s.status === 'missed' || s.isMissed,
  )
  const fromToday = today.filter(
    (s) => s.status === 'missed' || s.isMissed || (s.status === 'pending' && s.isOverdue),
  )
  return [...fromYesterday, ...fromToday]
}

export async function loadSalahAccountabilityContext(
  now = new Date(),
  userMessage = '',
): Promise<SalahContext | undefined> {
  if (userMessage && isPrayerTimeInquiry(userMessage)) {
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

    if (accountable.length === 0) return undefined

    return {
      pendingWaqts: accountable.map((s) => ({
        waqt: s.date === yesterdayYmd ? `${s.waqt} (গতকাল)` : s.waqt,
        isOverdue: s.isOverdue,
        isMissed: s.isMissed || s.status === 'missed',
      })),
    }
  } catch {
    return undefined
  }
}
