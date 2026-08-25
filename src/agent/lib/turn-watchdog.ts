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
import { finalizeTurnIfRunning } from '@/agent/lib/turn-status'

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
    const seq = lastSeq + 1
    const payload = { type: 'error', message: WATCHDOG_TERMINAL_MESSAGE }
    try {
      await db.agentTurnEvent.create({
        data: { turnId, seq, type: 'error', payload },
      })
    } catch {
      // Unique conflict = a racing writer took this seq; the turn is not as
      // dead as it looked (or a concurrent sweep won). Leave it for the next
      // pass rather than fight over the log.
      return false
    }
    await db.agentTurn.updateMany({ where: { id: turnId }, data: { lastSeq: seq } }).catch(() => {})
    await publishTerminal(turnId, seq, payload)
    await finalizeTurnIfRunning(turnId, 'error')
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
  batchLimit = 50,
): Promise<StrandedSweepResult> {
  const cutoff = new Date(now.getTime() - staleMs)
  const candidates: Array<{ id: string; startedAt: Date }> = await db.agentTurn.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    orderBy: { startedAt: 'asc' },
    take: batchLimit,
    select: { id: true, startedAt: true },
  })

  const result: StrandedSweepResult = { scanned: candidates.length, reaped: [], stillAlive: 0 }
  for (const turn of candidates) {
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
  return result
}
