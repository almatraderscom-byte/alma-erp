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

/** Replay the durable event log for a turn, oldest first. Fail-open to []. */
export async function getReplayEvents(turnId: string): Promise<TurnEvent[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).agentTurnEvent.findMany({
      where: { turnId },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, payload: true },
    })
    return rows as TurnEvent[]
  } catch (err) {
    console.warn('[turn-events] getReplayEvents failed:', err instanceof Error ? err.message : err)
    return []
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
