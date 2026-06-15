import type { SalahTimeConfig, WaqtKey } from '@/lib/salah/time-config'
import { dhakaInstant } from '@/lib/salah/dhaka-utils'

export type WaqtSchedule = {
  start: Date
  end: Date
  label: string
  azanLabel?: string
  prayerLabel?: string
  azan: Date
  prayerStart: Date
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'

export function hmToInstant(ymd: string, hm: string): Date {
  const [h, m] = String(hm).split(':').map(Number)
  return dhakaInstant(ymd, h, m)
}

/** Bangla label from HH:MM (hour without leading zero, e.g. 03:43 → ৩:৪৩). */
export function hmToBanglaLabel(hm: string): string {
  const [h, m] = hm.split(':')
  const toBn = (s: string) => s.replace(/\d/g, (d) => BN_DIGITS[Number(d)])
  return `${toBn(String(Number(h)))}:${toBn(m)}`
}

export function buildDhakaSchedule(
  ymd: string,
  cfg: SalahTimeConfig,
  friday: boolean,
): Record<WaqtKey, WaqtSchedule> {
  const fajrAzan = hmToInstant(ymd, cfg.fajr.azan)
  const fajrEnd = hmToInstant(ymd, cfg.fajr.end)

  const dhuhrAzan = friday ? dhakaInstant(ymd, 13, 0) : hmToInstant(ymd, cfg.dhuhr.azan)
  const dhuhrPrayer = hmToInstant(ymd, cfg.dhuhr.prayer)
  const dhuhrEnd = hmToInstant(ymd, cfg.dhuhr.end)

  const asrAzan = hmToInstant(ymd, cfg.asr.azan)
  const asrPrayer = hmToInstant(ymd, cfg.asr.prayer)
  const asrEnd = hmToInstant(ymd, cfg.asr.end)

  const maghribAzan = hmToInstant(ymd, cfg.maghrib.azan)
  const maghribEnd = hmToInstant(ymd, cfg.maghrib.end)

  const ishaAzan = hmToInstant(ymd, cfg.isha.azan)
  const ishaPrayer = hmToInstant(ymd, cfg.isha.prayer)
  const ishaEnd = hmToInstant(ymd, cfg.isha.end)

  return {
    fajr: {
      start: fajrAzan,
      end: fajrEnd,
      azan: fajrAzan,
      prayerStart: hmToInstant(ymd, cfg.fajr.prayer),
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
      prayerStart: hmToInstant(ymd, cfg.maghrib.prayer),
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
