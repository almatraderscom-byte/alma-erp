export const MORAL_WINDOW_BEFORE_MIN = 15
export const MORAL_WINDOW_AFTER_MIN = 30
export const MAX_DELAY_MIN = 45

export type DutyWindow = { start: Date; end: Date }

/** prayerStartIso = jamat/prayer time for the waqt (NOT azan). */
export function dutyWindow(prayerStartIso: string): DutyWindow {
  const prayer = new Date(prayerStartIso).getTime()
  return {
    start: new Date(prayer - MORAL_WINDOW_BEFORE_MIN * 60_000),
    end: new Date(prayer + MORAL_WINDOW_AFTER_MIN * 60_000),
  }
}

export function isWithinDutyWindow(prayerStartIso: string, now = new Date()): boolean {
  const w = dutyWindow(prayerStartIso)
  return now >= w.start && now <= w.end
}

// ── Button snooze (🕐 পরে পড়বো → ১৫ / ৩০ মিনিট) ──────────────────────────────
// Unlike the voice/text delay (bounded to prayer + 30 min), the Telegram snooze
// buttons are allowed from prayer − 15 min all the way to the WAQT END, so the
// owner can keep pushing calls back (15 min at a time) until the waqt closes.
export const SNOOZE_15_MIN = 15
export const SNOOZE_30_MIN = 30

/** Snooze allowed from prayer − 15 min until the waqt end (exclusive). */
export function isWithinSnoozeWindow(
  prayerStartIso: string,
  waqtEndIso: string,
  now = new Date(),
): boolean {
  const start = new Date(prayerStartIso).getTime() - MORAL_WINDOW_BEFORE_MIN * 60_000
  const end = new Date(waqtEndIso).getTime()
  const t = now.getTime()
  return Number.isFinite(start) && Number.isFinite(end) && t >= start && t < end
}

/**
 * Lock-until for a fixed-length button snooze (15 or 30 min), capped at the waqt
 * end. Returns null outside the snooze window (caller must NOT claim a lock then).
 */
export function computeSnoozeLockUntil(
  prayerStartIso: string,
  waqtEndIso: string,
  requestedMin: number,
  now = new Date(),
): { lockUntil: Date; grantedMin: number } | null {
  if (!isWithinSnoozeWindow(prayerStartIso, waqtEndIso, now)) return null
  const end = new Date(waqtEndIso)
  const reqMs = Math.max(requestedMin, 1) * 60_000
  const desired = new Date(now.getTime() + reqMs)
  const lockUntil = desired > end ? end : desired
  const grantedMin = Math.round((lockUntil.getTime() - now.getTime()) / 60_000)
  if (grantedMin < 1) return null
  return { lockUntil, grantedMin }
}

/**
 * Compute lock-until for owner delay request. Returns null if outside the window.
 * Caps at MAX_DELAY_MIN and never past window end (prayer + 30 min).
 */
export function computeLockUntil(
  prayerStartIso: string,
  requestedMin: number,
  now = new Date(),
): { lockUntil: Date; grantedMin: number } | null {
  if (!isWithinDutyWindow(prayerStartIso, now)) return null
  const w = dutyWindow(prayerStartIso)
  const reqMs = Math.min(Math.max(requestedMin, 1), MAX_DELAY_MIN) * 60_000
  const desired = new Date(now.getTime() + reqMs)
  const lockUntil = desired > w.end ? w.end : desired
  const grantedMin = Math.round((lockUntil.getTime() - now.getTime()) / 60_000)
  if (grantedMin < 1) return null
  return { lockUntil, grantedMin }
}
