/**
 * L4/L7 — the durable session-notification sweep, shared by the events ingest
 * (per-session, on every accepted batch) and the live-activity poll (global,
 * throttled) so an owed push from a session that will never speak again still
 * goes out. Lives outside route.ts because Next.js route modules may only
 * export HTTP methods.
 */

function isQuestion(text: string | null): boolean {
  return /\?\s*$/.test(text ?? '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepUnpushedNotables(db: any, sessionId: string) {
  try {
    const candidates: Array<{
      id: string
      seq: number
      kind: string
      text: string | null
      isError: boolean
      pushAttempts: number
    }> = await db.macAgentSessionEvent.findMany({
      where: {
        sessionId,
        pushedAt: null,
        pushAttempts: { lt: 3 },
        OR: [{ kind: 'error' }, { kind: 'ended' }, { kind: 'turn_done' }],
      },
      orderBy: { seq: 'desc' },
      // Wider than the batch cap (80): even an all-turn_done maximum batch
      // cannot bury an older owed question below the sweep (Codex, L7 round 3).
      take: 100,
      select: { id: true, seq: true, kind: true, text: true, isError: true, pushAttempts: true },
    })
    if (candidates.length === 0) return

    // Push ONLY when the newest terminal row is itself notable. An owed
    // question that a newer quiet turn_done has superseded settles silently —
    // the session moved past it, and pushing it late would mislead (Codex,
    // L7 round 4).
    const newest = candidates[0]
    const newestIsNotable =
      newest.kind === 'error' || newest.kind === 'ended' || newest.isError || isQuestion(newest.text)
    const settleSilently = candidates.filter((c) => !(newestIsNotable && c.id === newest.id))
    if (settleSilently.length > 0) {
      await db.macAgentSessionEvent.updateMany({
        where: { id: { in: settleSilently.map((c) => c.id) } },
        data: { pushedAt: new Date() },
      })
    }
    if (!newestIsNotable) return
    const notable = newest

    // CLAIM before sending: two overlapping POSTs (a daemon retry racing the
    // first invocation still waiting on OneSignal) must not both read the
    // same owed row and double-push. The attempts bump is the optimistic
    // lock — exactly one invocation wins it (Codex, L7 round 5).
    const claim = await db.macAgentSessionEvent.updateMany({
      where: { id: notable.id, pushedAt: null, pushAttempts: notable.pushAttempts },
      data: { pushAttempts: { increment: 1 } },
    })
    if (claim.count === 0) return // another invocation owns this push

    const { pushNativeToOwner } = await import('@/agent/lib/native-owner-push')
    const title =
      notable.kind === 'error'
        ? 'সেশনে সমস্যা হয়েছে'
        : notable.kind === 'ended'
          ? 'সেশন শেষ হয়েছে'
          : notable.isError
            ? 'সেশনের টার্ন ব্যর্থ'
            : 'সেশন আপনার উত্তর চাইছে'
    const send = () =>
      pushNativeToOwner({
        tier: 2,
        title,
        message: (notable.text ?? '').slice(0, 160) || 'বিস্তারিত দেখতে ট্যাপ করুন।',
        notificationKind: 'alert',
        actionUrl: '/agent',
        // One push per (session, seq) forever — the dedupe id, not a timer.
        deliveryId: `mac-session:${sessionId}:${notable.seq}`,
      })
    // A waiting-for-answer or ended session may NEVER emit another event, so
    // "retry on the next POST" alone can strand its notification (Codex, L7
    // round 5): ride out a transient blip with one in-request retry.
    let result = await send()
    if (!result.ok && result.attempted) {
      await new Promise((r) => setTimeout(r, 1_500))
      result = await send()
    }
    // Settled: delivered, OR a clean no-op (push disabled / unconfigured /
    // filtered by preference) that a retry would repeat identically. A
    // genuine transport failure keeps the row owed (the claim already spent
    // one attempt); the dock's live-activity poll and any later event POST
    // sweep it again.
    if (result.ok || !result.attempted) {
      await db.macAgentSessionEvent.update({
        where: { id: notable.id },
        data: { pushedAt: new Date() },
      })
    }
  } catch {
    /* push is best-effort per request; the ledger keeps it owed for next time */
  }
}

/**
 * Exported retry driver: the dock's live-activity poll calls this (throttled)
 * so an owed notification from a session that will never speak again still
 * goes out without waiting for another daemon event.
 */
let lastGlobalSweepAt = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepOwedSessionPushes(db: any) {
  if (Date.now() - lastGlobalSweepAt < 30_000) return
  lastGlobalSweepAt = Date.now()
  try {
    const owed: Array<{ sessionId: string }> = await db.macAgentSessionEvent.findMany({
      where: { pushedAt: null, pushAttempts: { lt: 3 }, OR: [{ kind: 'error' }, { kind: 'ended' }, { kind: 'turn_done' }] },
      distinct: ['sessionId'],
      take: 5,
      select: { sessionId: true },
    })
    for (const row of owed) await sweepUnpushedNotables(db, row.sessionId)
  } catch {
    /* best-effort */
  }
}
