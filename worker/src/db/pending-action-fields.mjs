/**
 * agent_pending_actions uses Prisma camelCase column names in Postgres ("createdAt", etc.).
 * Always use these helpers from worker Supabase writes/queries.
 */

export const PENDING_ACTION_COLUMNS = {
  createdAt: 'createdAt',
  resolvedAt: 'resolvedAt',
  costEstimate: 'costEstimate',
  conversationId: 'conversationId',
}

/** @param {string} status */
export function pendingResolvedUpdate(status) {
  return {
    status,
    resolvedAt: new Date().toISOString(),
  }
}

/**
 * Transient approval cards die after 30 min — mirror of the Vercel side
 * (src/agent/lib/pending-action.ts + constants.ts) so the worker's "N pending"
 * reminders never disagree with the in-app Approval Center / get_pending_approvals.
 */
export const PENDING_ACTION_EXPIRY_MS = 30 * 60 * 1000

/**
 * Types that are NOT transient confirmations — a standing, DB-backed proposal
 * that legitimately lives for many hours (the daily staff dispatch card). These
 * never expire on the 30-min clock; they retire by being superseded/executed.
 */
const LIFECYCLE_BOUND_ACTION_TYPES = new Set(['dispatch_staff_tasks'])

/**
 * @param {string|Date} createdAt
 * @param {string} [type]
 * @returns {boolean} true when a transient pending card has aged past its TTL.
 */
export function isPendingActionExpired(createdAt, type) {
  if (type && LIFECYCLE_BOUND_ACTION_TYPES.has(type)) return false
  return Date.now() - new Date(createdAt).getTime() > PENDING_ACTION_EXPIRY_MS
}
