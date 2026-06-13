/**
 * Reliable Asia/Dhaka calendar date — do NOT use bare toLocaleDateString on VPS
 * (ICU/timezone data may fall back to UTC and store the wrong day).
 */

const DHAKA_TZ = 'Asia/Dhaka'

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DHAKA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today as YYYY-MM-DD in Dhaka. */
export function dhakaTodayYmd(now = new Date()) {
  return ymdFormatter.format(now)
}

/** Calendar date ymd (Dhaka) → Date at UTC midnight; matches ERP attendanceDateFor(). */
export function dhakaMidnightUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Noon on a Dhaka calendar day — stable anchor for adhan.js. */
export function dhakaNoonUtc(ymd) {
  return new Date(`${ymd}T12:00:00+06:00`)
}

/** Date string matching what PostgreSQL stores for a Dhaka calendar day. */
export function salahDateFilter(ymd) {
  return ymd
}

export function dhakaYesterdayYmd(now = new Date()) {
  const [y, m, d] = dhakaTodayYmd(now).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}
