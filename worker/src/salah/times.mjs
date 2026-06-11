/**
 * Prayer times calculator for Dhaka, Bangladesh.
 *
 * Uses verified static +06:00 times (adhan.js returns one day early on UTC VPS hosts).
 * Keep in sync with src/agent/lib/salah-times.ts
 */

import { dhakaTodayYmd } from './dhaka-date.mjs'

/**
 * @param {Date} date — anchor instant; calendar day taken in Asia/Dhaka
 */
export async function getPrayerTimes(date = new Date()) {
  const ymd = dhakaTodayYmd(date)

  function t(h, min) {
    return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:00`)
  }

  return {
    fajr:    { start: t(3, 43),  end: t(5, 11)  },
    dhuhr:   { start: t(12, 3),  end: t(15, 17) },
    asr:     { start: t(15, 17), end: t(18, 48) },
    maghrib: { start: t(18, 48), end: t(20, 2)  },
    isha:    { start: t(20, 2),  end: t(23, 2)  },
  }
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
