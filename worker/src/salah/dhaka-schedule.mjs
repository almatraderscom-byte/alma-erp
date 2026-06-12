/**
 * Sir's Dhaka mosque schedule (+06:00).
 * Keep in sync with src/agent/lib/dhaka-schedule.ts
 */

/** @param {string} ymd YYYY-MM-DD Dhaka calendar day */
export function isFridayDhaka(ymd) {
  const noon = new Date(`${ymd}T12:00:00+06:00`)
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(noon) ===
    'Friday'
  )
}

/** @param {string} ymd @param {number} h @param {number} min */
export function dhakaInstant(ymd, h, min) {
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:00`)
}

/**
 * @param {string} ymd
 * @returns {Promise<Record<string, { start: Date, end: Date, azan: Date, prayerStart: Date, label?: string, azanLabel?: string, prayerLabel?: string }>>}
 */
export async function getDhakaSchedule(ymd) {
  const friday = isFridayDhaka(ymd)

  const fajrAzan = dhakaInstant(ymd, 3, 43)
  const fajrEnd = dhakaInstant(ymd, 5, 11)

  const dhuhrAzan = friday ? dhakaInstant(ymd, 13, 0) : dhakaInstant(ymd, 12, 30)
  const dhuhrPrayer = dhakaInstant(ymd, 13, 30)
  const dhuhrEnd = dhakaInstant(ymd, 15, 17)

  const asrAzan = dhakaInstant(ymd, 16, 30)
  const asrPrayer = dhakaInstant(ymd, 17, 0)
  const asrEnd = dhakaInstant(ymd, 18, 30)

  const maghribStart = dhakaInstant(ymd, 18, 45)
  const maghribEnd = dhakaInstant(ymd, 20, 13)

  const ishaAzan = dhakaInstant(ymd, 20, 13)
  const ishaPrayer = dhakaInstant(ymd, 20, 45)
  const ishaEnd = dhakaInstant(ymd, 23, 0)

  return {
    fajr: {
      start: fajrAzan,
      end: fajrEnd,
      azan: fajrAzan,
      prayerStart: fajrAzan,
      label: 'ফজর',
      azanLabel: '৩:৪৩',
    },
    dhuhr: {
      start: dhuhrAzan,
      end: dhuhrEnd,
      azan: dhuhrAzan,
      prayerStart: dhuhrPrayer,
      label: friday ? 'জুম্মা' : 'যোহর',
      azanLabel: friday ? '১:০০' : '১২:৩০',
      prayerLabel: '১:৩০',
    },
    asr: {
      start: asrAzan,
      end: asrEnd,
      azan: asrAzan,
      prayerStart: asrPrayer,
      label: 'আসর',
      azanLabel: '৪:৩০',
      prayerLabel: '৫:০০',
    },
    maghrib: {
      start: maghribStart,
      end: maghribEnd,
      azan: maghribStart,
      prayerStart: maghribStart,
      label: 'মাগরিব',
      azanLabel: '৬:৪৫',
    },
    isha: {
      start: ishaAzan,
      end: ishaEnd,
      azan: ishaAzan,
      prayerStart: ishaPrayer,
      label: 'ইশা',
      azanLabel: '৮:১৩',
      prayerLabel: '৮:৪৫',
    },
  }
}
