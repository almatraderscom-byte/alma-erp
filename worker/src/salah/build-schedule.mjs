/**
 * Build schedule from configurable HH:MM times — mirror src/lib/salah/build-schedule.ts
 */

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'

export function hmToInstant(ymd, hm) {
  const [h, m] = String(hm).split(':').map(Number)
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+06:00`)
}

export function hmToBanglaLabel(hm) {
  const [h, m] = hm.split(':')
  const toBn = (s) => s.replace(/\d/g, (d) => BN_DIGITS[Number(d)])
  return `${toBn(String(Number(h)))}:${toBn(m)}`
}

export function buildDhakaSchedule(ymd, cfg, friday, dhakaInstant) {
  // EVERY instant goes through the injected `dhakaInstant` (which carries the
  // owner's location offset — review-bot P1 on PR #650: hmToInstant hard-codes
  // +06 and must only be the Dhaka default at call sites, never in here).
  const hm = (t) => {
    const [h, m] = String(t).split(':').map(Number)
    return dhakaInstant(ymd, h, m)
  }
  // A wall-clock end EARLIER than the azan means "past midnight" (AlAdhan's
  // Isha end / Islamic midnight is 00:xx) — roll it into the next day so the
  // window stays valid (review-bot P1 #2).
  const endAfter = (azanDate, endHm) => {
    const e = hm(endHm)
    return e <= azanDate ? new Date(e.getTime() + 86_400_000) : e
  }

  const fajrAzan = hm(cfg.fajr.azan)
  const fajrEnd = endAfter(fajrAzan, cfg.fajr.end)

  const dhuhrAzan = friday ? dhakaInstant(ymd, 13, 0) : hm(cfg.dhuhr.azan)
  const dhuhrPrayer = hm(cfg.dhuhr.prayer)
  const dhuhrEnd = endAfter(dhuhrAzan, cfg.dhuhr.end)

  const asrAzan = hm(cfg.asr.azan)
  const asrPrayer = hm(cfg.asr.prayer)
  const asrEnd = endAfter(asrAzan, cfg.asr.end)

  const maghribAzan = hm(cfg.maghrib.azan)
  const maghribEnd = endAfter(maghribAzan, cfg.maghrib.end)

  const ishaAzan = hm(cfg.isha.azan)
  const ishaPrayer = hm(cfg.isha.prayer)
  const ishaEnd = endAfter(ishaAzan, cfg.isha.end)

  return {
    fajr: {
      start: fajrAzan,
      end: fajrEnd,
      azan: fajrAzan,
      prayerStart: hm(cfg.fajr.prayer),
      label: 'ফজর',
      azanLabel: hmToBanglaLabel(cfg.fajr.azan),
    },
    dhuhr: {
      start: dhuhrAzan,
      end: dhuhrEnd,
      azan: dhuhrAzan,
      prayerStart: dhuhrPrayer,
      label: friday ? 'জুম্মা' : 'যোহর',
      azanLabel: friday ? '১:০০' : hmToBanglaLabel(cfg.dhuhr.azan),
      prayerLabel: hmToBanglaLabel(cfg.dhuhr.prayer),
    },
    asr: {
      start: asrAzan,
      end: asrEnd,
      azan: asrAzan,
      prayerStart: asrPrayer,
      label: 'আসর',
      azanLabel: hmToBanglaLabel(cfg.asr.azan),
      prayerLabel: hmToBanglaLabel(cfg.asr.prayer),
    },
    maghrib: {
      start: maghribAzan,
      end: maghribEnd,
      azan: maghribAzan,
      prayerStart: hm(cfg.maghrib.prayer),
      label: 'মাগরিব',
      azanLabel: hmToBanglaLabel(cfg.maghrib.azan),
    },
    isha: {
      start: ishaAzan,
      end: ishaEnd,
      azan: ishaAzan,
      prayerStart: ishaPrayer,
      label: 'ইশা',
      azanLabel: hmToBanglaLabel(cfg.isha.azan),
      prayerLabel: hmToBanglaLabel(cfg.isha.prayer),
    },
  }
}
