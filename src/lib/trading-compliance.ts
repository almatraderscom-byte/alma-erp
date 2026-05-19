/**
 * Bangladesh business calendar (Asia/Dhaka, UTC+6, no DST).
 * We shift instants by +6h and read UTC date parts — equivalent to Asia/Dhaka local time.
 */
export const BD_OFFSET_MS = 6 * 60 * 60 * 1000

export function tradingBdNow(): Date {
  return new Date(Date.now() + BD_OFFSET_MS)
}

/** Map any UTC instant to BD calendar YYYY-MM-DD. */
export function tradingBdYmdFromInstant(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return new Date(d.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10)
}

export function tradingBdDayBounds(date = tradingBdNow()): { start: Date; end: Date; ymd: string } {
  const ymd = date.toISOString().slice(0, 10)
  const start = new Date(`${ymd}T00:00:00.000Z`)
  start.setTime(start.getTime() - BD_OFFSET_MS)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end, ymd }
}

/** BD day window [start, end) for a stored UTC instant's calendar day in Dhaka. */
export function tradingBdDayBoundsForInstant(instant: Date | string): { start: Date; end: Date; ymd: string } {
  const ymd = tradingBdYmdFromInstant(instant)
  const start = new Date(`${ymd}T00:00:00.000Z`)
  start.setTime(start.getTime() - BD_OFFSET_MS)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end, ymd }
}

export function tradingScreenshotCutoffHour(): number {
  const raw = Number(process.env.TRADING_SCREENSHOT_CUTOFF_HOUR_BD ?? 18)
  return Number.isFinite(raw) ? Math.min(23, Math.max(0, Math.floor(raw))) : 18
}

/** BD hour (0–23) after which prior-day PENDING Telegram drafts auto-lock. Default 6. */
export function telegramDraftLockHourBd(): number {
  const raw = Number(process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD ?? 6)
  return Number.isFinite(raw) ? Math.min(23, Math.max(0, Math.floor(raw))) : 6
}

export function isPastScreenshotCutoff(now = tradingBdNow()): boolean {
  const hour = now.getUTCHours()
  return hour >= tradingScreenshotCutoffHour()
}

export function screenshotUploadedToday(lastScreenshotAt: Date | string | null | undefined, today = tradingBdNow()): boolean {
  if (!lastScreenshotAt) return false
  const { ymd } = tradingBdDayBounds(today)
  return tradingBdYmdFromInstant(lastScreenshotAt) === ymd
}

export type ScreenshotComplianceStatus = 'COMPLETE' | 'DUE' | 'OVERDUE' | 'NOT_REQUIRED'

export function screenshotComplianceStatus(
  lastScreenshotAt: Date | string | null | undefined,
  now = tradingBdNow(),
): ScreenshotComplianceStatus {
  if (screenshotUploadedToday(lastScreenshotAt, now)) return 'COMPLETE'
  if (!isPastScreenshotCutoff(now)) return 'DUE'
  return 'OVERDUE'
}
