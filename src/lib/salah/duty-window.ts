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
