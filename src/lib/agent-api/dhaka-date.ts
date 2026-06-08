export { getPeriodRangeDhaka, isoToYmd, type PeriodRange } from '@/lib/agent-api/period'

const DHAKA_TZ = 'Asia/Dhaka'

/** Today as yyyy-MM-dd in Asia/Dhaka. */
export function todayYmdDhaka(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function dhakaMidnightUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+06:00`)
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days))
  return dt.toISOString().slice(0, 10)
}

export function daysAgoYmd(days: number, now = new Date()): string {
  return addDaysYmd(todayYmdDhaka(now), -days)
}
