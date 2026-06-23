import { PENDING_ACTION_EXPIRY_MS } from '@/agent/lib/constants'

/**
 * Action types that are NOT transient confirmations. They represent a standing,
 * DB-backed proposal that legitimately lives for many hours and is edited over
 * time — e.g. the daily staff dispatch card: created by the 21:05 evening
 * proposal, edited through the next day (merge_into_proposal), and approved the
 * following morning. Approving one always re-reads the live `proposed` rows from
 * the DB (refreshAndApproveDispatch), so there is no "stale card" risk and the
 * 30-minute transient TTL does not apply. These cards are retired by being
 * SUPERSEDED by a newer proposal, never by a clock — applying the 30-min TTL was
 * silently expiring cards the owner approved instantly (HTTP 410), so nothing got
 * dispatched.
 */
const LIFECYCLE_BOUND_ACTION_TYPES = new Set<string>(['dispatch_staff_tasks'])

export function isLifecycleBoundAction(type?: string | null): boolean {
  return !!type && LIFECYCLE_BOUND_ACTION_TYPES.has(type)
}

export function pendingActionAgeMs(createdAt: Date | string): number {
  return Date.now() - new Date(createdAt).getTime()
}

export function isPendingActionExpired(
  createdAt: Date | string,
  type?: string | null,
): boolean {
  // Lifecycle-bound cards never expire on the transient clock.
  if (isLifecycleBoundAction(type)) return false
  return pendingActionAgeMs(createdAt) > PENDING_ACTION_EXPIRY_MS
}
