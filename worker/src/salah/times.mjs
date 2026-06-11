/**
 * Prayer times calculator for Dhaka, Bangladesh.
 * Uses Adhan.js library. Falls back to static estimates if unavailable.
 *
 * Dhaka coordinates: 23.8103°N, 90.4125°E
 * Calculation method: MoonsightingCommittee (standard for BD)
 *
 * ESM note: adhan v4.x exports named exports only — no default export,
 * and DateComponents was removed; PrayerTimes takes a plain Date.
 */

// Cache resolved named exports across calls
let adhanExports = null

async function getAdhan() {
  if (adhanExports) return adhanExports
  try {
    // adhan v4 ESM: named exports, no default
    const mod = await import('adhan')
    // Destructure the named exports we need
    const { Coordinates, CalculationMethod, Madhab, PrayerTimes } = mod
    if (!Coordinates || !PrayerTimes) throw new Error('unexpected adhan export shape')
    adhanExports = { Coordinates, CalculationMethod, Madhab, PrayerTimes }
    return adhanExports
  } catch (err) {
    console.warn('[salah] adhan package not available — using static estimates:', err.message)
    return null
  }
}

/**
 * Returns prayer times for a given date as { fajr, dhuhr, asr, maghrib, isha } Date objects.
 * Window end = start of next prayer (isha window = +3h after isha start).
 */
export async function getPrayerTimes(date = new Date()) {
  const adhan = await getAdhan()

  if (adhan) {
    try {
      const { Coordinates, CalculationMethod, Madhab, PrayerTimes } = adhan

      const coordinates = new Coordinates(23.8103, 90.4125)
      const params       = CalculationMethod.MoonsightingCommittee()
      params.madhab      = Madhab.Shafi  // Common in Bangladesh

      // adhan v4: PrayerTimes(coordinates, Date, params) — no DateComponents
      const times = new PrayerTimes(coordinates, date, params)

      return {
        fajr:    { start: times.fajr,    end: times.sunrise },
        dhuhr:   { start: times.dhuhr,   end: times.asr },
        asr:     { start: times.asr,     end: times.maghrib },
        maghrib: { start: times.maghrib, end: times.isha },
        isha:    { start: times.isha,    end: new Date(times.isha.getTime() + 3 * 60 * 60 * 1000) },
      }
    } catch (err) {
      console.error('[salah] adhan calculation error:', err.message)
      // Fall through to static fallback
    }
  }

  // Fallback: static Dhaka estimates (approximate, UTC+6)
  const y = date.getFullYear(), m = date.getMonth(), day = date.getDate()

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
