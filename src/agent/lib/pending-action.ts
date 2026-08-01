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
const LIFECYCLE_BOUND_ACTION_TYPES = new Set<string>([
  'dispatch_staff_tasks',
  // Office-absence cards: the owner may answer minutes-to-an-hour later (he's away
  // from the office), and the follow-up option cards are retired by being tapped /
  // superseded — not by the 30-min transient clock. Expiring them mid-flow would
  // strand the "did you send staff out?" question with a 410.
  'office_absence_confirm',
  'office_absence_snooze',
  'office_absence_nudge',
  'office_absence_nudge_send',
  // OWNER INCIDENT 2026-07-26. A ten-product SEO copy batch expired on the
  // 30-minute clock while Boss was reading it. He asked for it again, the agent
  // re-DRAFTED from scratch, that one expired too — four rounds, four different
  // texts, four approvals, and his verdict was exact: "erta ki kono kaj?"
  //
  // Nothing about drafted copy goes stale in thirty minutes. It is a standing
  // proposal like the dispatch card above: the payload holds the exact text and
  // the exact image URLs, approving it writes those, and a newer batch supersedes
  // it. A clock has no business in it, and expiring it is what created the loop.
  'seo_fix_batch',
  // A permission card carries its OWN absolute cutoff in the payload, and its
  // text tells Boss that approving late simply leaves less time on the clock.
  // The generic 30-minute TTL contradicted that for any grant longer than half
  // an hour — a four-hour card refused at minute 31 (review bot, #667). The
  // approve route checks `expiresAt` itself and fails with `grant_window_passed`.
  'permission_grant',
])

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
