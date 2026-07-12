/**
 * Prayer times for Dhaka — Boss's local mosque schedule.
 */

import { dhakaTodayYmd } from './dhaka-date.mjs'
import { getDhakaSchedule } from './dhaka-schedule.mjs'

/**
 * @param {Date} date — anchor instant; calendar day taken in Asia/Dhaka
 */
export async function getPrayerTimes(date = new Date()) {
  const ymd = dhakaTodayYmd(date)
  const schedule = await getDhakaSchedule(ymd)
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
