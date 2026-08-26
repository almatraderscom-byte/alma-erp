/**
 * Turn event replay + live tail (Component A2).
 *
 * A worker-executed turn publishes each SSE event to a Redis pub/sub channel
 * (`turn:<id>:events`, ephemeral) AND appends it to `agent_turn_events`
 * (durable). The stream endpoint first REPLAYS the durable log in `seq` order,
 * then TAILS the channel for anything newer. The two streams overlap by design
 * (a row may already be in the log when its publish arrives), so emission is
 * deduped by monotonically increasing `seq`.
 *
 * The pure helpers below (dedup + terminal + framing) carry the ordering
 * guarantee the endpoint depends on and are unit-tested without Redis.
 */
import { prisma } from '@/lib/prisma'
import {
  shouldRenderAgentReferences,
  type AgentReferenceEnv,
} from '@/agent/lib/references/flags'

export interface TurnEvent {
  seq: number
  type: string
  /** The original SSE event object the client consumes (e.g. { type, delta }). */
  payload: unknown
}

/** Redis pub/sub channel a turn's worker publishes to. */
export const turnEventChannel = (turnId: string) => `turn:${turnId}:events`

/** A 'done'/'error' event ends the stream — nothing more will be published. */
export function isTerminalEventType(type: string): boolean {
  return type === 'done' || type === 'error'
}

/**
 * Guards against emitting the same event twice when the replayed log and the
 * live tail overlap. Accepts strictly increasing `seq` only.
 */
export function createSeqDeduper(initialLastSeq = -1) {
  let lastSeq = initialLastSeq
  return {
    accept(seq: number): boolean {
      if (seq <= lastSeq) return false
      lastSeq = seq
      return true
    },
    get lastSeq() {
      return lastSeq
    },
  }
}

/** SSE wire frame for one event payload. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * Durable turn rows may have been written while reference rendering was ON and
 * replayed later after the rollout was moved to SHADOW/OFF. Sanitize at the
 * single delivery boundary (rather than trusting write-time flags) so replay,
 * Redis tail and database polling all obey the current kill switch.
 *
 * `references`/`done` events intentionally carry an authoritative empty array:
 * clients use it to clear an older projection. Nested reference projections are
 * removed as well, including presentation/tool envelopes embedded in an event.
 */
export function sanitizeTurnEventPayloadForReferenceRollout(
  payload: unknown,
  env: AgentReferenceEnv = process.env,
): unknown {
  if (shouldRenderAgentReferences(env)) return payload

  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (!value || typeof value !== 'object') return value
    const clean: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'references') continue
      clean[key] = strip(nested)
    }
    return clean
  }

  const clean = strip(payload)
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return clean
  const event = clean as Record<string, unknown>
  // An empty array alone reads as "the contract is live and this reply cited
  // nothing", which made replayed/tail terminals turn legacy links and trusted
  // screenshots inert in hidden mode (Codex P1, PR #845). Say inactive out loud.
  return event.type === 'references' || event.type === 'done'
    ? { ...event, references: [], referencesActive: false }
    : event
}

/** Replay the durable event log for a turn, oldest first.
 *  `afterSeq` (roadmap 3.5) replays only events NEWER than the client's cursor;
 *  `limit` caps pathological turns while the cursor allows continuation.
 *  Default fail-open to [] (advisory callers); the stream endpoint passes
 *  `throwOnError` because a replay it cannot read must end the stream with an
 *  explicit error rather than start a live-only tail mid-turn (F-09). */
export async function getReplayEvents(
  turnId: string,
  afterSeq = -1,
  limit = 5000,
  opts?: { throwOnError?: boolean },
): Promise<TurnEvent[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).agentTurnEvent.findMany({
      where: { turnId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
      select: { seq: true, type: true, payload: true },
    })
    return rows as TurnEvent[]
  } catch (err) {
    console.warn('[turn-events] getReplayEvents failed:', err instanceof Error ? err.message : err)
    if (opts?.throwOnError) throw err
    return []
  }
}

/**
 * Roadmap 3.4 — ONE durable event publisher shared by every execution mode.
 * The VPS worker already mirrors its events into `agent_turn_events` + Redis;
 * this gives the INLINE (serverless) execution the same durability, so a
 * reconnecting client can replay a direct turn instead of waiting for polls.
 *
 * Semantics per event: append durable row FIRST (bounded retries), then publish
 * live, then bump `AgentTurn.lastSeq` — the same order the worker uses. A row
 * that cannot be stored is neither published nor counted (fail-closed, R-3).
 * Writes are serialized on an internal chain so the SSE hot loop never awaits
 * the database; text/thinking deltas are coalesced (~350ms or maxChars) to keep
 * row counts sane, and control events flush pending deltas first so replay
 * chronology is exact.
 */
export interface TurnEventPublisher {
  emit(event: { type: string; [k: string]: unknown }): void
  /** Flush + await every pending write. Returns the final lastSeq. */
  finish(): Promise<number>
  /** Events that could not be stored durably (and were therefore not published). */
  durabilityHoles(): number
  /** End the revocation lease because THIS executor is settling normally —
   * called before finalizeTurnIfRunning so the lease poll cannot mistake our
   * own terminal status for a foreign claim and drop the still-pending
   * durable tail (Codex P2 #859 r6). Idempotent. */
  releaseLease(): void
}

const DEFAULT_DURABLE_RETRY_DELAYS_MS = [50, 200, 600]

export function createTurnEventPublisher(
  turnId: string,
  opts?: {
    coalesceMs?: number
    maxDeltaChars?: number
    retryDelaysMs?: number[]
    /** Execution-revocation lease (Codex P1 #859 r4): when the turn row has
     * been claimed away from 'running' (reopen revive, watchdog), the next
     * durable write past the check interval detects it, drops the write —
     * nothing may land after another writer's terminal — and fires this so
     * the executor aborts instead of running further side effects. */
    onRevoked?: () => void
    revokeCheckMs?: number
  },
): TurnEventPublisher {
  const coalesceMs = opts?.coalesceMs ?? 350
  const maxDeltaChars = opts?.maxDeltaChars ?? 2000
  const retryDelaysMs = opts?.retryDelaysMs ?? DEFAULT_DURABLE_RETRY_DELAYS_MS
  const onRevoked = opts?.onRevoked
  const revokeCheckMs = Math.max(opts?.revokeCheckMs ?? 10_000, 25)
  let lastRevokeCheck = Date.now()
  let revoked = false
  let leaseReleased = false
  let leaseTimer: ReturnType<typeof setInterval> | null = null

  function markRevoked() {
    if (leaseReleased) return
    revoked = true
    stopLeaseTimer()
    try { onRevoked?.() } catch { /* abort callback must not break the chain */ }
  }

  function stopLeaseTimer() {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null }
  }

  /** One row-status lease read. Shared by the timer and the write chain. */
  async function pollLeaseNow(): Promise<boolean> {
    if (leaseReleased) return false
    if (revoked) return true
    lastRevokeCheck = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).agentTurn.findUnique({ where: { id: turnId }, select: { status: true } })
      if (row && row.status !== 'running') markRevoked()
    } catch { /* lease check is best-effort — the run continues */ }
    return revoked
  }

  // Independent lease poll (Codex P1 #859 r5): a turn quiet inside a long
  // tool call produces NO events, so a chain-only check could never abort it
  // before the tool returned. The timer polls regardless of event flow; it is
  // stopped on revocation and in finish().
  if (onRevoked) {
    leaseTimer = setInterval(() => { void pollLeaseNow() }, revokeCheckMs)
    ;(leaseTimer as { unref?: () => void }).unref?.()
  }

  /** Throttled chain-side lease check (the timer does the steady polling). */
  async function leaseRevoked(): Promise<boolean> {
    if (revoked) return true
    if (leaseReleased || !onRevoked) return false
    if (Date.now() - lastRevokeCheck < revokeCheckMs) return false
    return pollLeaseNow()
  }
  let seq = -1
  let holes = 0
  /** A `done`/`error` whose durable write failed every attempt (type kept for the repair). */
  let terminalLost: string | null = null
  let chain: Promise<void> = Promise.resolve()
  // Prose lifecycle v2: a text delta may carry `blockId`/`revision`. Deltas are
  // coalesced only within ONE block — merging across blocks would corrupt the
  // identity a v2 client addresses prose by.
  let pendingDelta: { type: 'text_delta' | 'thinking_delta'; delta: string; blockId?: unknown; revision?: unknown } | null = null
  let deltaTimer: ReturnType<typeof setTimeout> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any | null = null
  let redisTried = false

  async function redisPublisher() {
    if (redisTried) return redis
    redisTried = true
    const url = process.env.LONG_TASK_REDIS_URL || process.env.REDIS_URL
    if (!url) return null
    try {
      const { default: Redis } = await import('ioredis')
      redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    } catch (err) {
      console.warn('[turn-events] publisher redis unavailable:', err instanceof Error ? err.message : err)
      redis = null
    }
    return redis
  }

  /** Durable append with bounded retries. Returns false when the row was never stored.
   * Atomic ownership (Codex P2 #859 r5): a plain create makes an occupied seq
   * LOUD — the old upsert(update:{}) silently "succeeded" on a foreign row
   * (e.g. a reviver's terminal) and then published OUR payload at that seq,
   * letting live subscribers advance past a terminal replay contains. On
   * P2002 the row is fetched: an identical row is our own crash-retry
   * duplicate (success); a different one is a foreign writer — the lease is
   * gone, nothing is published, and the executor is aborted. */
  async function storeDurably(mySeq: number, event: { type: string }): Promise<boolean> {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).agentTurnEvent.create({
          data: { turnId, seq: mySeq, type: event.type, payload: event },
        })
        return true
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const existing = await (prisma as any).agentTurnEvent.findUnique({
              where: { turnId_seq: { turnId, seq: mySeq } },
              select: { type: true, payload: true },
            })
            if (existing && existing.type === event.type
              && JSON.stringify(existing.payload) === JSON.stringify(event)) {
              return true // our own earlier write landed — retry made it look new
            }
          } catch { /* fall through to revocation — never publish over a foreign row */ }
          markRevoked()
          // Even after releaseLease, a foreign row at this seq must never be
          // shadowed — the write is dropped either way.
          revoked = true
          return false
        }
        lastError = err
        if (attempt < retryDelaysMs.length) {
          await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
        }
      }
    }
    console.error(`[turn-events] durable write seq=${mySeq} FAILED after ${retryDelaysMs.length + 1} attempts:`, lastError instanceof Error ? lastError.message : lastError)
    return false
  }

  function writeRow(event: { type: string }) {
    seq += 1
    const mySeq = seq
    chain = chain.then(async () => {
      // Revoked lease: another writer (reopen revive / watchdog) owns the
      // terminal now — nothing more may be stored or published after it.
      if (await leaseRevoked()) return
      // Reliability epic R-3 (handoff F-09): durable FIRST; an event that could
      // not be stored is neither published nor counted in lastSeq — the live
      // tail and the replay log must never disagree about what happened.
      const stored = await storeDurably(mySeq, event)
      if (!stored) {
        // A revoked lease is not a durability hole: a foreign terminal owns
        // the log now and the tail settles from it — repairing would append
        // BEHIND that terminal.
        if (revoked) return
        holes += 1
        if (isTerminalEventType(event.type)) terminalLost = event.type
        return
      }
      try {
        const pub = await redisPublisher()
        if (pub) await pub.publish(turnEventChannel(turnId), JSON.stringify({ seq: mySeq, type: event.type, payload: event }))
      } catch (err) {
        console.warn(`[turn-events] live publish seq=${mySeq} failed:`, err instanceof Error ? err.message : err)
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).agentTurn.updateMany({ where: { id: turnId }, data: { lastSeq: mySeq } })
      } catch {
        /* lastSeq is advisory — replay still works from the rows themselves */
      }
    })
  }

  function flushDelta() {
    if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null }
    if (!pendingDelta) return
    const d = pendingDelta
    pendingDelta = null
    writeRow({
      type: d.type,
      delta: d.delta,
      ...(d.blockId !== undefined ? { blockId: d.blockId } : {}),
      ...(d.revision !== undefined ? { revision: d.revision } : {}),
    } as { type: string })
  }

  return {
    emit(event) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (
          pendingDelta
          && pendingDelta.type === event.type
          && pendingDelta.blockId === event.blockId
          && pendingDelta.revision === event.revision
        ) {
          pendingDelta.delta += delta
        } else {
          flushDelta()   // switching delta kind/block is chronology — flush the old one
          pendingDelta = { type: event.type, delta, blockId: event.blockId, revision: event.revision }
        }
        if (pendingDelta.delta.length >= maxDeltaChars) {
          flushDelta()
        } else if (!deltaTimer) {
          deltaTimer = setTimeout(flushDelta, coalesceMs)
        }
        return
      }
      flushDelta()       // control events land AFTER the prose that preceded them
      writeRow(event)
    },
    releaseLease() {
      leaseReleased = true
      stopLeaseTimer()
    },
    async finish() {
      leaseReleased = true
      stopLeaseTimer()
      flushDelta()
      await chain
      if (terminalLost) {
        // The log has no terminal: a client that reconnects after the live SSE
        // dropped would tail forever. Repair with an explicit durable terminal
        // (its own seq, full retries); if even that fails, reject so the caller
        // cannot mistake the turn for cleanly finished (Codex P1 #837).
        const lost = terminalLost
        terminalLost = null
        writeRow({ type: 'error', message: `turn_terminal_not_durable:${lost}` } as { type: string })
        await chain
        if (terminalLost) {
          if (redis) {
            try { await redis.quit() } catch { redis.disconnect?.() }
          }
          throw new Error(`[turn-events] turn ${turnId}: terminal event could not be stored durably`)
        }
      }
      if (redis) {
        try { await redis.quit() } catch { redis.disconnect?.() }
      }
      if (holes > 0) console.error(`[turn-events] turn ${turnId} finished with ${holes} durable hole(s) — replay is incomplete`)
      return seq
    },
    durabilityHoles() {
      return holes
    },
  }
}

/**
 * Open a dedicated Redis subscriber for a turn's channel. Returns a handle with
 * `onEvent` registration and `close`, or null if Redis isn't configured.
 * ioredis is imported lazily so the route never pulls it in when unused.
 */
/**
 * The same live tail, over the DATABASE instead of Redis.
 *
 * Measured 2026-07-27 while planning the Upstash removal, and it corrects what
 * the handoff notes say: that shared cloud Redis is not "only the queue". It is
 * also the only live path from the VPS worker back to a Vercel stream — the
 * worker publishes each event to it and this route subscribes. With the quota
 * exhausted, `subscribeTurnEvents` returns null and a worker-run turn cannot be
 * watched at all, however healthy the worker is.
 *
 * The durable log does not have that problem: the worker writes every event to
 * `agent_turn_events` BEFORE publishing, so the rows are complete on their own.
 * Polling them costs one indexed query per second per open stream — one owner,
 * one or two streams — and it removes the metered dependency from the read path
 * entirely. The trade is honest: ~1s of latency instead of instant.
 */
export function pollTurnEvents(
  turnId: string,
  afterSeq: number,
  onEvent: (evt: TurnEvent) => void,
  intervalMs = 1000,
): { close: () => Promise<void> } {
  let cursor = afterSeq
  let stopped = false
  let inFlight = false

  const tick = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const rows = await getReplayEvents(turnId, cursor, 500)
      for (const evt of rows) {
        if (stopped) break
        cursor = Math.max(cursor, evt.seq)
        onEvent(evt)
      }
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  void tick()

  return {
    close: async () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

export async function subscribeTurnEvents(
  turnId: string,
  onEvent: (evt: TurnEvent) => void,
  opts?: { signal?: AbortSignal },
): Promise<{ close: () => Promise<void> } | null> {
  // Must match the Redis the worker PUBLISHES to (LONG_TASK_REDIS_URL on the
  // worker), so the live tail sees the worker's events. Same precedence as the
  // enqueue side: LONG_TASK_REDIS_URL first, then REDIS_URL.
  const url = process.env.LONG_TASK_REDIS_URL || process.env.REDIS_URL
  if (!url) return null
  const signal = opts?.signal
  if (signal?.aborted) return null
  let sub: { disconnect: () => void; quit: () => Promise<unknown> } | null = null
  // The tailer aborts an attempt that outlives its deadline: stop reconnecting
  // and fail the pending SUBSCRIBE instead of leaking a client per stream for
  // the length of a Redis outage (Codex P1 #836 r4).
  const onAbort = () => { sub?.disconnect() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const { default: Redis } = await import('ioredis')
    if (signal?.aborted) return null
    const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    sub = client
    client.on('error', () => { /* surfaced by the pending command / close path */ })
    client.on('message', (_channel, raw) => {
      try {
        const evt = JSON.parse(raw) as TurnEvent
        if (evt && typeof evt.seq === 'number') onEvent(evt)
      } catch {
        /* malformed publish — ignore */
      }
    })
    await client.subscribe(turnEventChannel(turnId))
    if (signal?.aborted) {
      client.disconnect()
      return null
    }
    signal?.removeEventListener('abort', onAbort)
    return {
      close: async () => {
        try {
          await client.quit()
        } catch {
          client.disconnect()
        }
      },
    }
  } catch (err) {
    signal?.removeEventListener('abort', onAbort)
    sub?.disconnect()
    if (!signal?.aborted) {
      console.warn('[turn-events] subscribeTurnEvents failed:', err instanceof Error ? err.message : err)
    }
    return null
  }
}
