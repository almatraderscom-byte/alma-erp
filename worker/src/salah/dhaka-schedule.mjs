/**
 * Sir's Dhaka mosque schedule (+06:00) — reads configurable times from KV.
 * Keep defaults in sync with src/lib/salah/time-config.ts
 */

import { getSalahTimeConfig } from './time-config.mjs'
import { buildDhakaSchedule } from './build-schedule.mjs'

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
 * @param {import('./time-config.mjs').DEFAULT_SALAH_TIMES|object} [cfgOverride]
 * @returns {Promise<Record<string, { start: Date, end: Date, azan: Date, prayerStart: Date, label?: string, azanLabel?: string, prayerLabel?: string }>>}
 */
export async function getDhakaSchedule(ymd, cfgOverride) {
  const cfg = cfgOverride ?? await getSalahTimeConfig()
  const friday = isFridayDhaka(ymd)
  return buildDhakaSchedule(ymd, cfg, friday, dhakaInstant)
}
