/**
 * Stranded-turn watchdog (owner incident 2026-08-26).
 *
 * A turn's executing process can die WITHOUT running its finalize path — a
 * pm2 restart during an engine/worker deploy, a function crash, an OOM. The
 * turn row then stays 'running' forever, and every client honestly-but-
 * uselessly shows "কাজ চলছে — সংযোগ ফিরছে…" for as long as the owner stares
 * at it: the sweep of 2026-08-26 found FIFTY-FOUR such corpses dating back to
 * June. Plan-driver steps have had a ghost reaper (DISPATCH_GHOST_MS) all
 * along; chat-lane turns had nothing. This is that reaper.
 *
 * A turn is STRANDED when it is 'running' and its last sign of life — the
 * newest durable event, or the turn's start when it never produced one — is
 * older than the stale window. Activity, not age: a legitimate hour-long
 * engine slice keeps emitting thinking/tool events and is never touched,
 * while a corpse that has been silent for the whole window cannot be alive
 * (the in-process salvage would have produced a terminal long before).
 *
 * Settlement is the same contract every other terminal uses: one durable
 * `error` event at the next seq (so exact-turn tails settle from the log),
 * published on the live Redis channel (so an attached tail settles without
 * waiting for its status poll), then the row is finalized — status-pollers
 * settle from that. Clients already handle all three paths.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** No event for this long ⇒ the executing process is dead. Comfortably above
 * every legitimate quiet stretch (provider thinking gaps, long tool calls)
 * and aligned with the plan-driver's DISPATCH_GHOST_MS precedent. */
export const TURN_STALE_MS = 30 * 60 * 1000

export const WATCHDOG_TERMINAL_MESSAGE = 'turn_watchdog_stranded'

export interface StrandedSweepResult {
  scanned: number
  reaped: string[]
  /** Turns that were old but showed recent event activity (left alone). */
  stillAlive: number
}

async function latestEvent(turnId: string): Promise<{ seq: number; createdAt: Date } | null> {
  const row = await db.agentTurnEvent.findFirst({
    where: { turnId },
    orderBy: { seq: 'desc' },
    select: { seq: true, createdAt: true },
  })
  return row ? { seq: Number(row.seq), createdAt: new Date(row.createdAt) } : null
}

async function publishTerminal(turnId: string, seq: number, payload: Record<string, unknown>): Promise<void> {
  const url = process.env.LONG_TASK_REDIS_URL || process.env.REDIS_URL
  if (!url) return
  try {
    const { default: Redis } = await import('ioredis')
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 4000,
      retryStrategy: () => null,
    })
    redis.on('error', () => { /* surfaced by the failed publish below */ })
    try {
      await redis.publish(`turn:${turnId}:events`, JSON.stringify({ seq, type: 'error', payload }))
    } finally {
      try { await redis.quit() } catch { redis.disconnect?.() }
    }
  } catch (err) {
    // Live-channel delivery is best-effort — the durable row + finalized
    // status settle every reconnecting client within one poll anyway.
    console.warn('[turn-watchdog] terminal publish failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Reap one stranded turn: durable terminal event, live publish, row finalize.
 * Never throws — one broken turn must not stop the sweep.
 */
async function reapTurn(turnId: string, lastSeq: number): Promise<boolean> {
  try {
    // CLAIM FIRST (Codex P1 #857 r2): the turn may settle legitimately
    // between candidate selection and this reap — appending a watchdog error
    // to a genuinely done turn would feed exact-turn tails a false failure.
    // The status CAS is the claim; losing it means the real executor settled
    // and there is nothing to repair. The brief claimed-but-no-terminal-row
    // window is already handled by the tailer's status-only settlement.
    const claimed = await db.agentTurn.updateMany({
      where: { id: turnId, status: 'running' },
      data: { status: 'error', finishedAt: new Date() },
    })
    if (!claimed?.count) return false
    const seq = lastSeq + 1
    const payload = { type: 'error', message: WATCHDOG_TERMINAL_MESSAGE }
    try {
      await db.agentTurnEvent.create({
        data: { turnId, seq, type: 'error', payload },
      })
    } catch {
      // Unique conflict = a racing writer took this seq. The row is already
      // finalized by our claim; status-only settlement covers the tails.
      return true
    }
    await db.agentTurn.updateMany({ where: { id: turnId }, data: { lastSeq: seq } }).catch(() => {})
    await publishTerminal(turnId, seq, payload)
    return true
  } catch (err) {
    console.warn(`[turn-watchdog] reap failed for ${turnId}:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Sweep every stranded 'running' turn. Bounded batch per pass — the cron
 * comes back; a pathological backlog must not blow the function budget.
 */
export async function sweepStrandedTurns(
  now: Date = new Date(),
  staleMs: number = TURN_STALE_MS,
  /** Caps REAPS per pass, not scans: a backlog of long-running-but-alive old
   * turns at the head of the startedAt ordering must not starve stranded
   * turns behind them forever (Codex P2 #857). */
  batchLimit = 50,
  scanLimit = 500,
): Promise<StrandedSweepResult> {
  const cutoff = new Date(now.getTime() - staleMs)
  const result: StrandedSweepResult = { scanned: 0, reaped: [], stillAlive: 0 }
  // Keyset pagination (Codex P2 #857 r3): a fixed head window could in theory
  // be fully occupied by alive long-runners; pages walk the whole backlog
  // within one pass, bounded only by the reap cap and a hard scan ceiling.
  let cursor: { startedAt: Date; id: string } | null = null
  const hardScanCeiling = scanLimit * 4
  while (result.scanned < hardScanCeiling && result.reaped.length < batchLimit) {
    const page: Array<{ id: string; startedAt: Date }> = await db.agentTurn.findMany({
      where: {
        status: 'running',
        ...(cursor
          ? {
              OR: [
                { startedAt: { gt: cursor.startedAt, lt: cutoff } },
                { startedAt: cursor.startedAt, id: { gt: cursor.id } },
              ],
            }
          : { startedAt: { lt: cutoff } }),
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(scanLimit, hardScanCeiling - result.scanned),
      select: { id: true, startedAt: true },
    })
    if (page.length === 0) break
    for (const turn of page) {
      result.scanned += 1
      if (result.reaped.length >= batchLimit) break
      const newest = await latestEvent(turn.id)
      const lastActivity = newest && newest.createdAt > turn.startedAt ? newest.createdAt : new Date(turn.startedAt)
      if (now.getTime() - lastActivity.getTime() < staleMs) {
        // Old turn, fresh events: a long slice that is genuinely alive.
        result.stillAlive += 1
        continue
      }
      if (await reapTurn(turn.id, newest?.seq ?? -1)) {
        result.reaped.push(turn.id)
        console.warn(`[turn-watchdog] reaped stranded turn ${turn.id} (started ${turn.startedAt.toISOString()}, last activity ${lastActivity.toISOString()})`)
      }
    }
    const last = page[page.length - 1]
    cursor = { startedAt: new Date(last.startedAt), id: last.id }
    if (page.length < scanLimit) break
  }
  return result
}
