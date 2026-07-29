/**
 * Prayer times for Dhaka — Boss's local mosque schedule.
 */

import { dhakaTodayYmd } from './dhaka-date.mjs'
import { getDhakaSchedule } from './dhaka-schedule.mjs'

/**
 * @param {Date} date — anchor instant; calendar day taken at the salah location
 * @param {number} [offsetMin] UTC offset minutes (owner rule ৪); default Dhaka
 */
export async function getPrayerTimes(date = new Date(), offsetMin = 360) {
  const ymd = offsetMin === 360
    ? dhakaTodayYmd(date)
    : new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10)
  const schedule = await getDhakaSchedule(ymd, undefined, offsetMin)
  const out = {}
  for (const [waqt, w] of Object.entries(schedule)) {
    out[waqt] = {
      start: w.start,
      end: w.end,
      azan: w.azan,
      prayerStart: w.prayerStart,
      label: w.label,
      azanLabel: w.azanLabel,
      prayerLabel: w.prayerLabel,
    }
  }
  return out
}

/**
 * Returns the percentage of the current prayer window that has elapsed (0-100).
 */
export function windowProgress(windowStart, windowEnd) {
  const now   = Date.now()
  const start = new Date(windowStart).getTime()
  const end   = new Date(windowEnd).getTime()
  if (now <= start) return 0
  if (now >= end)   return 100
  return Math.round(((now - start) / (end - start)) * 100)
}
