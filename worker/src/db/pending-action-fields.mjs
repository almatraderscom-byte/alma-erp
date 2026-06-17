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
