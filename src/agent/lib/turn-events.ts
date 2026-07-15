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

/** Replay the durable event log for a turn, oldest first. Fail-open to [].
 *  `afterSeq` (roadmap 3.5) replays only events NEWER than the client's cursor;
 *  `limit` caps pathological turns while the cursor allows continuation. */
export async function getReplayEvents(
  turnId: string,
  afterSeq = -1,
  limit = 5000,
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
    return []
  }
}

/**
 * Roadmap 3.4 — ONE durable event publisher shared by every execution mode.
 * The VPS worker already mirrors its events into `agent_turn_events` + Redis;
 * this gives the INLINE (serverless) execution the same durability, so a
 * reconnecting client can replay a direct turn instead of waiting for polls.
 *
 * Semantics per event: append durable row FIRST, then publish live, then bump
 * `AgentTurn.lastSeq` — the same order the worker uses. Writes are serialized on
 * an internal chain so the SSE hot loop never awaits the database; text/thinking
 * deltas are coalesced (~350ms or maxChars) to keep row counts sane, and control
 * events flush pending deltas first so replay chronology is exact.
 */
export interface TurnEventPublisher {
  emit(event: { type: string; [k: string]: unknown }): void
  /** Flush + await every pending write. Returns the final lastSeq. */
  finish(): Promise<number>
}

export function createTurnEventPublisher(
  turnId: string,
  opts?: { coalesceMs?: number; maxDeltaChars?: number },
): TurnEventPublisher {
  const coalesceMs = opts?.coalesceMs ?? 350
  const maxDeltaChars = opts?.maxDeltaChars ?? 2000
  let seq = -1
  let chain: Promise<void> = Promise.resolve()
  let pendingDelta: { type: 'text_delta' | 'thinking_delta'; delta: string } | null = null
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

  function writeRow(event: { type: string }) {
    seq += 1
    const mySeq = seq
    chain = chain.then(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).agentTurnEvent.upsert({
          where: { turnId_seq: { turnId, seq: mySeq } },
          create: { turnId, seq: mySeq, type: event.type, payload: event },
          update: {},
        })
      } catch (err) {
        console.warn(`[turn-events] durable write seq=${mySeq} failed:`, err instanceof Error ? err.message : err)
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
    writeRow({ type: d.type, delta: d.delta } as { type: string })
  }

  return {
    emit(event) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (pendingDelta && pendingDelta.type === event.type) {
          pendingDelta.delta += delta
        } else {
          flushDelta()   // switching delta kind is chronology — flush the old kind
          pendingDelta = { type: event.type, delta }
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
    async finish() {
      flushDelta()
      await chain
      if (redis) {
        try { await redis.quit() } catch { redis.disconnect?.() }
      }
      return seq
    },
  }
}

/**
 * Open a dedicated Redis subscriber for a turn's channel. Returns a handle with
 * `onEvent` registration and `close`, or null if Redis isn't configured.
 * ioredis is imported lazily so the route never pulls it in when unused.
 */
export async function subscribeTurnEvents(
  turnId: string,
  onEvent: (evt: TurnEvent) => void,
): Promise<{ close: () => Promise<void> } | null> {
  // Must match the Redis the worker PUBLISHES to (LONG_TASK_REDIS_URL on the
  // worker), so the live tail sees the worker's events. Same precedence as the
  // enqueue side: LONG_TASK_REDIS_URL first, then REDIS_URL.
  const url = process.env.LONG_TASK_REDIS_URL || process.env.REDIS_URL
  if (!url) return null
  try {
    const { default: Redis } = await import('ioredis')
    const sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false })
    sub.on('message', (_channel, raw) => {
      try {
        const evt = JSON.parse(raw) as TurnEvent
        if (evt && typeof evt.seq === 'number') onEvent(evt)
      } catch {
        /* malformed publish — ignore */
      }
    })
    await sub.subscribe(turnEventChannel(turnId))
    return {
      close: async () => {
        try {
          await sub.quit()
        } catch {
          sub.disconnect()
        }
      },
    }
  } catch (err) {
    console.warn('[turn-events] subscribeTurnEvents failed:', err instanceof Error ? err.message : err)
    return null
  }
}
