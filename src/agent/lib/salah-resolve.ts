/**
 * Shared salah status rules — agent API, auto-mark, and worker escalation must agree.
 */

export const SETTLED_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

export function isSalahSettled(status: string): boolean {
  return SETTLED_STATUSES.has(status)
}

/** Owner confirmed prayer (button, auto-mark, or mark_salah) — never nag or auto-miss again. */
export function isOwnerConfirmed(record: { status: string; confirmedAt?: Date | string | null }): boolean {
  if (isSalahSettled(record.status)) return true
  return record.confirmedAt != null
}

/** Scheduler may still remind / mark missed only for untouched pending rows. */
export function shouldEscalateSalah(record: { status: string; confirmedAt?: Date | string | null }): boolean {
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
