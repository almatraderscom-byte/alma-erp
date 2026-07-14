/**
 * Message-history pagination (roadmap Phase 4.1).
 *
 * The messages GET route historically returned the COMPLETE conversation and the
 * clients re-fetched it every 12s — network, decode and reconciliation cost grew
 * with thread length. These pure helpers translate the additive query params into
 * a Prisma query plan; no params = legacy full-history behavior, so old clients
 * are untouched.
 *
 *   ?limit=50            → the LATEST 50 rows (ascending order in the response)
 *   ?limit=50&before=<id>→ the 50 rows OLDER than that message (scroll-up page)
 *   ?since=<ISO>         → only rows newer than the client's sync stamp (delta
 *                          poll; empty array = nothing changed, ~free)
 */

export const MESSAGES_PAGE_MAX = 200

export interface MessagesPagePlan {
  /** createdAt constraint to merge into the Prisma where clause, if any. */
  createdAt?: { gt?: Date } | { lt?: Date }
  /** take for Prisma; undefined = unbounded (legacy). */
  take?: number
  /** Fetch newest-first then reverse to ascending (latest-N semantics). */
  fetchDescThenReverse: boolean
}

export function buildMessagesPagePlan(opts: {
  limit?: string | null
  since?: string | null
  /** createdAt of the `before` anchor message (resolved by the route). */
  beforeCreatedAt?: Date | null
}): MessagesPagePlan {
  const parsed = Number.parseInt(opts.limit ?? '', 10)
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MESSAGES_PAGE_MAX) : null

  if (opts.since) {
    const d = new Date(opts.since)
    if (!Number.isNaN(d.getTime())) {
      // Delta poll: ascending, optionally capped — never desc (chronology).
      return { createdAt: { gt: d }, take: limit ?? undefined, fetchDescThenReverse: false }
    }
  }
  if (opts.beforeCreatedAt) {
    return {
      createdAt: { lt: opts.beforeCreatedAt },
      take: limit ?? undefined,
      // Page of history directly above the anchor: newest-first window, reversed.
      fetchDescThenReverse: limit != null,
    }
  }
  if (limit != null) {
    // Initial load: the latest N rows.
    return { take: limit, fetchDescThenReverse: true }
  }
  return { fetchDescThenReverse: false }   // legacy: full history ascending
}
