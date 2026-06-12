/**
 * Shared salah status rules — agent API, auto-mark, and worker escalation must agree.
 */

export const SETTLED_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

export function isSalahSettled(status: string): boolean {
  return SETTLED_STATUSES.has(status)
}

/** Raw DB row says owner confirmed (may include phantom / future waqt bugs). */
export function isOwnerConfirmed(record: { status: string; confirmedAt?: Date | string | null }): boolean {
  if (isSalahSettled(record.status)) return true
  return record.confirmedAt != null
}

/** Counts as done for status replies & accountability — window started, not phantom. */
export function isEffectivelyDone(
  record: { status: string; confirmedAt?: Date | string | null; windowStart: Date | string },
  now = new Date(),
): boolean {
  const windowStart = new Date(record.windowStart)
  if (!Number.isFinite(windowStart.getTime()) || now < windowStart) return false
  if (!isOwnerConfirmed(record)) return false
  if (isPhantomSalahConfirmation(record, windowStart)) return false
  return true
}

/** Confirmed before azan/window — agent/LLM marked too early; reminders must still fire. */
export function isPhantomSalahConfirmation(
  record: { confirmedAt?: Date | string | null; windowStart?: Date | string },
  azanOrWindowStart: Date,
): boolean {
  if (!record.confirmedAt) return false
  const confirmed = new Date(record.confirmedAt)
  const start = new Date(azanOrWindowStart)
  if (!Number.isFinite(confirmed.getTime()) || !Number.isFinite(start.getTime())) return false
  return confirmed < start
}

/** Scheduler may still remind / mark missed only for untouched pending rows. */
export function shouldEscalateSalah(
  record: { status: string; confirmedAt?: Date | string | null; windowStart?: Date | string },
  azanOrWindowStart?: Date,
): boolean {
  if (azanOrWindowStart && isPhantomSalahConfirmation(record, azanOrWindowStart)) return true
  return record.status === 'pending' && record.confirmedAt == null
}

export function resolvePrayedStatus(windowEnd: Date, now = new Date()): 'prayed_on_time' | 'prayed_late' {
  return now <= windowEnd ? 'prayed_on_time' : 'prayed_late'
}

/** Fix rows where owner confirmed but escalation left status pending/missed. */
export function reconcileConfirmedStatus(
  record: { status: string; confirmedAt?: Date | string | null; windowEnd: Date },
  now = new Date(),
): 'prayed_on_time' | 'prayed_late' | null {
  if (!record.confirmedAt) return null
  if (isSalahSettled(record.status)) return null
  return resolvePrayedStatus(record.windowEnd, now)
}
