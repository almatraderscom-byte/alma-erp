/**
 * Per-business office hours (Dhaka). Mirrors app-side officeHoursFor() in src/lib/attendance.ts.
 */

const OFFICE_HOURS = {
  ALMA_LIFESTYLE: { start: 9 * 60 + 30, end: 20 * 60 }, // 9:30 – 20:00
}

const DEFAULT_HOURS = { start: 9 * 60, end: 21 * 60 } // 9:00 – 21:00

function dhakaMinutesOfDay(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hh * 60 + mm
}

export function isWithinOfficeHours(businessId = 'ALMA_LIFESTYLE', now = new Date()) {
  const { start, end } = OFFICE_HOURS[businessId] ?? DEFAULT_HOURS
  const mins = dhakaMinutesOfDay(now)
  return mins >= start && mins < end
}

export function isWorkingTime(businessId = 'ALMA_LIFESTYLE', now = new Date()) {
  return isWithinOfficeHours(businessId, now)
}
