/**
 * Day-shift cadence — office-hours tick window + sparse patrol interval.
 * KV keys read each tick/run; cron rebuilt on worker boot + settings poll.
 */
import { prisma } from '@/lib/prisma'

export const DAYSHIFT_WINDOW_UTC_KEY = 'dayshift_window_utc'
export const DAYSHIFT_PATROL_INTERVAL_KEY = 'dayshift_patrol_interval_min'

export const DEFAULT_DAYSHIFT_WINDOW_UTC = '2-16'
export const DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN = 60

/** BullMQ cron: every 12 min during UTC hour window (default 08:00–22:00 Dhaka). */
export function buildDayShiftTickCron(windowUtc = DEFAULT_DAYSHIFT_WINDOW_UTC): string {
  const w = windowUtc.trim() || DEFAULT_DAYSHIFT_WINDOW_UTC
  return `*/12 ${w} * * *`
}

export function parseDayShiftWindowUtc(value: string | null | undefined): string {
  const v = value?.trim()
  if (!v) return DEFAULT_DAYSHIFT_WINDOW_UTC
  if (/^\d{1,2}-\d{1,2}$/.test(v)) return v
  return DEFAULT_DAYSHIFT_WINDOW_UTC
}

export function parsePatrolIntervalMin(value: string | null | undefined): number {
  if (value == null || value === '') return DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n < 15 || n > 240) return DEFAULT_DAYSHIFT_PATROL_INTERVAL_MIN
  return n
}

export function isWithinDayShiftWindowUtc(
  now = new Date(),
  windowUtc = DEFAULT_DAYSHIFT_WINDOW_UTC,
): boolean {
  const w = parseDayShiftWindowUtc(windowUtc)
  const [startStr, endStr] = w.split('-')
  const start = parseInt(startStr, 10)
  const end = parseInt(endStr, 10)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true
  const hourUtc = now.getUTCHours()
  return hourUtc >= start && hourUtc <= end
}

export async function getDayShiftWindowUtc(): Promise<string> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: DAYSHIFT_WINDOW_UTC_KEY } })
  return parseDayShiftWindowUtc(row?.value)
}

export async function getDayShiftPatrolIntervalMin(): Promise<number> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: DAYSHIFT_PATROL_INTERVAL_KEY } })
  return parsePatrolIntervalMin(row?.value)
}

export async function getDayShiftSettings(): Promise<{
  windowUtc: string
  patrolIntervalMin: number
  tickCronUtc: string
}> {
  const [windowUtc, patrolIntervalMin] = await Promise.all([
    getDayShiftWindowUtc(),
    getDayShiftPatrolIntervalMin(),
  ])
  return {
    windowUtc,
    patrolIntervalMin,
    tickCronUtc: buildDayShiftTickCron(windowUtc),
  }
}

/** Office hours for UI banner — 08:00–22:00 Asia/Dhaka (matches tick window). */
export function isDayShiftOfficeHoursDhaka(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const mins = hh * 60 + mm
  return mins >= 8 * 60 && mins < 22 * 60
}
