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

/** Dhaka midnight as UTC instant for API/DB date fields. */
export function dhakaMidnightUtc(ymd) {
  return new Date(`${ymd}T00:00:00+06:00`)
}

/** Noon on a Dhaka calendar day — stable anchor for adhan.js. */
export function dhakaNoonUtc(ymd) {
  return new Date(`${ymd}T12:00:00+06:00`)
}

export function dhakaYesterdayYmd(now = new Date()) {
  const today = dhakaMidnightUtc(dhakaTodayYmd(now))
  today.setDate(today.getDate() - 1)
  return ymdFormatter.format(today)
}
