export { getPeriodRangeDhaka, isoToYmd, type PeriodRange } from '@/lib/agent-api/period'

export const DHAKA_TZ = 'Asia/Dhaka'

/** yyyy-MM-dd bounds in Asia/Dhaka (+06:00) for DB occurred_at queries. */
export function dhakaDayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00+06:00`)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

export function dhakaMonthBounds(dateStr: string): { start: Date; end: Date } {
  const [y, m] = dateStr.split('-').map(Number)
  const start = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+06:00`)
  const nextMonth = m === 12 ? [y + 1, 1] : [y, m + 1]
  const end = new Date(`${nextMonth[0]}-${String(nextMonth[1]).padStart(2, '0')}-01T00:00:00+06:00`)
  return { start, end }
}

/** Today as yyyy-MM-dd in Asia/Dhaka. */
export function todayYmdDhaka(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Calendar date ymd (Dhaka) → Date at UTC midnight; matches ERP attendanceDateFor(). */
export function dhakaMidnightUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!))
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days))
  return dt.toISOString().slice(0, 10)
}

export function daysAgoYmd(days: number, now = new Date()): string {
  return addDaysYmd(todayYmdDhaka(now), -days)
}

/** Human-readable date+time in Asia/Dhaka — use for owner-facing agent replies. */
export function formatDateTimeDhaka(now = new Date(), hour12 = true): string {
  return now.toLocaleString('bn-BD', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12,
  })
}
