/**
 * Prayer times calculator for Dhaka, Bangladesh.
 * Uses Adhan.js library. Falls back to static estimates if unavailable.
 *
 * Dhaka coordinates: 23.8103°N, 90.4125°E
 * Calculation method: MoonsightingCommittee (standard for BD)
 */

// Dynamic import — adhan package may not be installed at startup
let Adhan = null

async function getAdhan() {
  if (Adhan) return Adhan
  try {
    const mod = await import('adhan')
    Adhan = mod.default || mod
    return Adhan
  } catch {
    console.warn('[salah] adhan package not available — using static estimates')
    return null
  }
}

/**
 * Returns prayer times for a given date as { fajr, dhuhr, asr, maghrib, isha } Date objects.
 * Also includes window end times (next prayer = end of window).
 */
export async function getPrayerTimes(date = new Date()) {
  const adhan = await getAdhan()

  if (adhan) {
    try {
      const coordinates = new adhan.Coordinates(23.8103, 90.4125)
      const params       = adhan.CalculationMethod.MoonsightingCommittee()
      params.madhab      = adhan.Madhab.Shafi  // Common in Bangladesh

      const prayerDate = new adhan.DateComponents(
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
      )

      const times = new adhan.PrayerTimes(coordinates, prayerDate, params)

      // Window end = next prayer start (isha ends at midnight of next day)
      const nextDay = new Date(date)
      nextDay.setDate(nextDay.getDate() + 1)
      const nextDayTimes = new adhan.PrayerTimes(
        coordinates,
        new adhan.DateComponents(nextDay.getFullYear(), nextDay.getMonth() + 1, nextDay.getDate()),
        params,
      )

      return {
        fajr:    { start: times.fajr,    end: times.sunrise },
        dhuhr:   { start: times.dhuhr,   end: times.asr },
        asr:     { start: times.asr,     end: times.maghrib },
        maghrib: { start: times.maghrib, end: times.isha },
        isha:    { start: times.isha,    end: new Date(times.isha.getTime() + 3 * 60 * 60 * 1000) },
      }
    } catch (err) {
      console.error('[salah] adhan calculation error:', err.message)
    }
  }

  // Fallback: static Dhaka estimates (approximate)
  const d = new Date(date)
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()

  function t(h, min) { return new Date(y, m, day, h, min, 0) }

  return {
    fajr:    { start: t(4, 45),  end: t(6, 15)  },
    dhuhr:   { start: t(12, 30), end: t(15, 30) },
    asr:     { start: t(15, 30), end: t(18, 0)  },
    maghrib: { start: t(18, 15), end: t(19, 30) },
    isha:    { start: t(19, 45), end: t(22, 30) },
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
