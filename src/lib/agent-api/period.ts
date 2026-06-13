import type { SummaryPeriod } from '@/lib/agent-api/orders.schema'

export interface PeriodRange {
  /** Inclusive yyyy-MM-dd for GAS / Sheets date filter */
  startDate: string
  endDate: string
  from: Date
  to: Date
}

const DHAKA_TZ = 'Asia/Dhaka'

function dhakaYmd(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number)
  return { y, m, d }
}

/** Calendar date ymd (Dhaka) → Date at UTC midnight; matches ERP attendanceDateFor(). */
function dhakaMidnightUtc(ymd: string): Date {
  const { y, m, d } = parseYmd(ymd)
  return new Date(Date.UTC(y, m - 1, d))
}

function addDaysYmd(ymd: string, days: number): string {
  const { y, m, d } = parseYmd(ymd)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

function weekdayDhaka(now: Date): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: DHAKA_TZ, weekday: 'short' }).format(now)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[wd] ?? 0
}

export function getPeriodRangeDhaka(period: SummaryPeriod, now: Date = new Date()): PeriodRange {
  const todayYmd = dhakaYmd(now)
  const tomorrowYmd = addDaysYmd(todayYmd, 1)

  switch (period) {
    case 'today':
      return {
        startDate: todayYmd,
        endDate: todayYmd,
        from: dhakaMidnightUtc(todayYmd),
        to: dhakaMidnightUtc(tomorrowYmd),
      }
    case 'yesterday': {
      const yYmd = addDaysYmd(todayYmd, -1)
      return {
        startDate: yYmd,
        endDate: yYmd,
        from: dhakaMidnightUtc(yYmd),
        to: dhakaMidnightUtc(todayYmd),
      }
    }
    case 'week': {
      const dow = weekdayDhaka(now)
      const mondayOffset = dow === 0 ? -6 : 1 - dow
      const weekStart = addDaysYmd(todayYmd, mondayOffset)
      return {
        startDate: weekStart,
        endDate: todayYmd,
        from: dhakaMidnightUtc(weekStart),
        to: dhakaMidnightUtc(tomorrowYmd),
      }
    }
    case 'month': {
      const { y, m } = parseYmd(todayYmd)
      const monthStart = `${y}-${String(m).padStart(2, '0')}-01`
      return {
        startDate: monthStart,
        endDate: todayYmd,
        from: dhakaMidnightUtc(monthStart),
        to: dhakaMidnightUtc(tomorrowYmd),
      }
    }
  }
}

export function isoToYmd(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return dhakaYmd(d)
}
