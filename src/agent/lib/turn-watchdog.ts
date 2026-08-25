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

/** Base staleness: no event for this long is suspicious. The EFFECTIVE
 * window (effectiveStaleMs) is never below the largest per-slice execution
 * budget + margin: the self-hosted engine legitimately allows a 1-hour slice
 * (AGENT_WORKER_RERUN_CAP_MS, turn-cap.ts) whose provider stream can be
 * quiet, and the watchdog changes only DB state — it cannot abort the
 * executor, so reaping a slice that may still be running would feed clients
 * a false error while side effects continue (Codex P1 #857 r4). Past the
 * slice cap the in-process salvage has fired, so a silent turn beyond the
 * window is genuinely dead. Raising the engine cap requires raising
 * AGENT_WORKER_RERUN_CAP_MS on Vercel too (docs/VPS_MODEL_LOOP.md).  */
export const TURN_STALE_MS = 30 * 60 * 1000
const SLICE_MARGIN_MS = 15 * 60 * 1000
const DEFAULT_MAX_SLICE_MS = 60 * 60 * 1000

export function effectiveStaleMs(baseStaleMs: number = TURN_STALE_MS): number {
  const configuredSlice = Number(process.env.AGENT_WORKER_RERUN_CAP_MS)
  const maxSlice = Number.isFinite(configuredSlice) && configuredSlice > 0
    ? Math.max(configuredSlice, DEFAULT_MAX_SLICE_MS)
    : DEFAULT_MAX_SLICE_MS
  return Math.max(baseStaleMs, maxSlice + SLICE_MARGIN_MS)
}

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
    let stored = false
    for (let attempt = 0; attempt < 3 && !stored; attempt++) {
      try {
        await db.agentTurnEvent.create({
          data: { turnId, seq, type: 'error', payload },
        })
        stored = true
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          // Unique conflict = a racing writer took this seq. The row is
          // already finalized by our claim; status-only settlement covers
          // the tails.
          return true
        }
        // Transient store error (Codex P2 #857 r6): the claim has already
        // finalized the row, so this reap will never be retried by a later
        // sweep — retry the durable terminal here before giving up on the
        // log (status-only settlement still covers every client either way).
        if (attempt === 2) {
          console.warn(`[turn-watchdog] terminal event store failed for ${turnId} after retries:`, err instanceof Error ? err.message : err)
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
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
const WATCHDOG_CURSOR_KEY = 'turn_watchdog_cursor'

async function readSweepCursor(): Promise<{ startedAt: Date; id: string } | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: WATCHDOG_CURSOR_KEY } })
    if (!row?.value) return null
    const parsed = JSON.parse(row.value) as { startedAt?: string; id?: string }
    if (!parsed?.startedAt || !parsed?.id) return null
    const at = new Date(parsed.startedAt)
    return Number.isFinite(at.getTime()) ? { startedAt: at, id: parsed.id } : null
  } catch {
    return null
  }
}

async function writeSweepCursor(cursor: { startedAt: Date; id: string } | null): Promise<void> {
  try {
    if (!cursor) {
      await db.agentKvSetting.deleteMany({ where: { key: WATCHDOG_CURSOR_KEY } })
      return
    }
    const value = JSON.stringify({ startedAt: cursor.startedAt.toISOString(), id: cursor.id })
    await db.agentKvSetting.upsert({
      where: { key: WATCHDOG_CURSOR_KEY },
      update: { value },
      create: { key: WATCHDOG_CURSOR_KEY, value },
    })
  } catch { /* a lost cursor restarts from the head — safe, just slower */ }
}

export async function sweepStrandedTurns(
  now: Date = new Date(),
  staleMs: number = effectiveStaleMs(),
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
  // The cursor PERSISTS across sweeps (Codex P2 #857 r4): even a backlog
  // larger than one pass's ceiling is eventually fully walked, then the
  // cursor resets and the scan starts from the head again.
  let cursor: { startedAt: Date; id: string } | null = await readSweepCursor()
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
    if (page.length === 0) {
      // Backlog exhausted exactly at a page boundary: clear the persisted
      // cursor, or the next sweep would resume at the tail forever and the
      // head would never be rescanned.
      if (cursor) await writeSweepCursor(null)
      break
    }
    // ONE grouped query per page instead of a serial lookup per turn — a
    // large alive backlog must not spend the cron's whole 120s budget on
    // round trips (Codex P2 #857 r6).
    const newestByTurn = new Map<string, { seq: number; createdAt: Date }>()
    try {
      const grouped: Array<{ turnId: string; _max: { seq: number | null; createdAt: Date | string | null } }> =
        await db.agentTurnEvent.groupBy({
          by: ['turnId'],
          where: { turnId: { in: page.map((t) => t.id) } },
          _max: { seq: true, createdAt: true },
        })
      for (const g of grouped) {
        if (g._max.seq != null && g._max.createdAt != null) {
          newestByTurn.set(g.turnId, { seq: Number(g._max.seq), createdAt: new Date(g._max.createdAt) })
        }
      }
    } catch { /* fall back to per-turn lookups below */ }
    for (const turn of page) {
      result.scanned += 1
      if (result.reaped.length >= batchLimit) break
      const newest = newestByTurn.get(turn.id) ?? await latestEvent(turn.id)
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
    cursor = page.length < scanLimit
      ? null // backlog fully walked — next sweep restarts at the head
      : { startedAt: new Date(last.startedAt), id: last.id }
    // Persist per PAGE, not once at the end (Codex P2 #857 r6): if the cron
    // function is killed at its time budget mid-sweep, the next run resumes
    // past the pages already walked instead of repeating them forever.
    await writeSweepCursor(cursor)
    if (!cursor) break
  }
  return result
}
