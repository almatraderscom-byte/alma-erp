import type { SalahTimeConfig, WaqtKey } from '@/lib/salah/time-config-shared'
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
  instant: (ymd: string, h: number, m: number) => Date = dhakaInstant,
): Record<WaqtKey, WaqtSchedule> {
  // Every instant goes through `instant` (location offset — PR #650 bot P1);
  // an end wall-clock earlier than the azan is past-midnight → next day.
  const hm = (t: string) => {
    const [h, m] = String(t).split(':').map(Number)
    return instant(ymd, h, m)
  }
  const endAfter = (azanDate: Date, endHm: string) => {
    const e = hm(endHm)
    return e <= azanDate ? new Date(e.getTime() + 86_400_000) : e
  }

  const fajrAzan = hm(cfg.fajr.azan)
  const fajrEnd = endAfter(fajrAzan, cfg.fajr.end)

  const dhuhrAzan = friday ? instant(ymd, 13, 0) : hm(cfg.dhuhr.azan)
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
