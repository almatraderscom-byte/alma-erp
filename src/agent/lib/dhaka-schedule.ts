/**
 * Sir's Dhaka mosque schedule (+06:00) — mirrors worker/src/salah/dhaka-schedule.mjs
 */
import { PrayerTimes, Coordinates, CalculationMethod } from 'adhan'

const DHAKA = new Coordinates(23.8103, 90.4125)
const ADHAN_PARAMS = CalculationMethod.Karachi()

export function isFridayDhaka(ymd: string): boolean {
  const noon = new Date(`${ymd}T12:00:00+06:00`)
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(noon) ===
    'Friday'
  )
}

export function dhakaInstant(ymd: string, h: number, min: number): Date {
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:00`)
}

function adhanTimes(ymd: string) {
  const pt = new PrayerTimes(DHAKA, new Date(`${ymd}T12:00:00+06:00`), ADHAN_PARAMS)
  return { maghrib: pt.maghrib, isha: pt.isha }
}

export type WaqtSchedule = {
  start: Date
  end: Date
  label: string
  azanLabel?: string
}

export async function getDhakaSchedule(ymd: string): Promise<Record<string, WaqtSchedule>> {
  const friday = isFridayDhaka(ymd)
  const adhan = adhanTimes(ymd)

  const fajrStart = dhakaInstant(ymd, 4, 15)
  const fajrEnd = dhakaInstant(ymd, 5, 30)
  const dhuhrStart = friday ? dhakaInstant(ymd, 13, 0) : dhakaInstant(ymd, 12, 15)
  const dhuhrEnd = dhakaInstant(ymd, 16, 45)
  const asrStart = dhakaInstant(ymd, 17, 0)
  const maghribStart = adhan.maghrib
  const ishaStart = adhan.isha

  return {
    fajr: { start: fajrStart, end: fajrEnd, label: 'ফজর', azanLabel: '৪:১৫' },
    dhuhr: {
      start: dhuhrStart,
      end: dhuhrEnd,
      label: friday ? 'জুম্মা' : 'যোহর',
      azanLabel: friday ? '১:০০ (জুম্মা ১:৩০)' : '১২:১৫',
    },
    asr: { start: asrStart, end: maghribStart, label: 'আসর', azanLabel: '৫:০০' },
    maghrib: { start: maghribStart, end: ishaStart, label: 'মাগরিব' },
    isha: { start: ishaStart, end: dhakaInstant(ymd, 23, 30), label: 'ইশা' },
  }
}
