import { afterEach, describe, expect, it, vi } from 'vitest'
import { tailExactTurnStream } from '@/agent/lib/durable-turn-stream-client'
import { runTurnTail, type TurnTailHandle, type TurnTailIO } from '@/agent/lib/turn-stream-tailer'

const INCIDENT = {
  conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
  turnId: '8c60fbe3-zero-event-production-turn',
  assistantMessageId: 'assistant-after-473871ms',
  terminalAtMs: 473_871,
  proxyEofAtMs: 300_000,
} as const

const encode = (payload: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)

describe('production incident exact-turn recovery acceptance', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('survives Redis-down + 300s EOF and observes the 474s zero-event DB terminal without rerunning the prompt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const opens: Array<{ at: number; turnId: string; afterSeq: number }> = []
    const statusReads: number[] = []
    const seen: Array<Record<string, unknown>> = []
    const persistedCursors: number[] = []
    const tails: TurnTailHandle[] = []
    let firstEofAt: number | null = null
    // Incremented only by a code path that would enqueue/execute owner work.
    let ownerPromptRuns = 0

    const open = async (turnId: string, afterSeq: number): Promise<Response> => {
      const connection = opens.length + 1
      opens.push({ at: Date.now(), turnId, afterSeq })
      if (turnId !== INCIDENT.turnId || afterSeq !== -1) ownerPromptRuns += 1

      let tail: TurnTailHandle | null = null
      let closed = false
      let proxyTimer: ReturnType<typeof setTimeout> | null = null

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => {
            if (closed) return
            closed = true
            if (proxyTimer) clearTimeout(proxyTimer)
            controller.close()
          }
          const send = (payload: unknown) => {
            if (!closed) controller.enqueue(encode(payload))
          }

          // This is an observation endpoint. Opening/reopening it must never
          // enqueue or execute another owner prompt.
          send({
            type: 'turn_snapshot',
            turnId: INCIDENT.turnId,
            conversationId: INCIDENT.conversationId,
            status: 'running',
            lastSeq: -1,
            assistantMessageId: null,
          })

          const io: TurnTailIO = {
            async getReplay() { return [] },
            async subscribe(_onEvent, signal) {
              // Production-shaped Redis outage: the connect promise does not
              // settle until the tailer's deadline aborts it.
              return new Promise<null>((resolve) => {
                signal?.addEventListener('abort', () => resolve(null), { once: true })
              })
            },
            async getStatus() {
              statusReads.push(Date.now())
              const done = Date.now() >= INCIDENT.terminalAtMs
              return {
                turnId: INCIDENT.turnId,
                conversationId: INCIDENT.conversationId,
                status: done ? 'done' : 'running',
                lastSeq: -1,
                assistantMessageId: done ? INCIDENT.assistantMessageId : null,
                continuationNeeded: false,
              }
            },
            poll() { return { close: async () => {} } },
            emit() { throw new Error('zero-event incident emitted a sequenced row') },
            control: send,
            finish: close,
          }

          tail = runTurnTail(io, {
            turnId: INCIDENT.turnId,
            afterSeq,
            snapshotLastSeq: -1,
            snapshotStatus: 'running',
            snapshotConversationId: INCIDENT.conversationId,
            subscribeTimeoutMs: 10,
            statusPollIntervalMs: 1_000,
          })
          tails.push(tail)

          if (connection === 1) {
            proxyTimer = setTimeout(() => {
              firstEofAt = Date.now()
              void tail?.close()
              close()
            }, INCIDENT.proxyEofAtMs)
          }
        },
        async cancel() {
          await tail?.close()
        },
      })

      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    let resolvedAt: number | null = null
    const recovery = tailExactTurnStream({
      turnId: INCIDENT.turnId,
      conversationId: INCIDENT.conversationId,
      initialAfterSeq: -1,
      open,
      onEvent(event) { seen.push(event) },
      onCursor(seq) { persistedCursors.push(seq) },
      maxReconnects: 2,
      reconnectDelayMs: 0,
      sleep: async () => {},
    }).then((result) => {
      resolvedAt = Date.now()
      return result
    })

    // Reproduce the exact proxy lifetime and the audited 473.871-second
    // database completion. The tail arms its 1s exact-status interval one
    // subscribe-deadline after each connection, so terminal observation lands
    // inside one poll period after the DB row flips — never before it.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(INCIDENT.proxyEofAtMs)
    await vi.advanceTimersByTimeAsync(175_000)

    await expect(recovery).resolves.toEqual({ lastSeq: -1, terminal: true })
    expect(firstEofAt).toBe(INCIDENT.proxyEofAtMs)
    // Exactly one reconnect, on the same exact turn, from the same cursor.
    expect(opens).toEqual([
      { at: 0, turnId: INCIDENT.turnId, afterSeq: -1 },
      { at: INCIDENT.proxyEofAtMs, turnId: INCIDENT.turnId, afterSeq: -1 },
    ])
    // Detection latency is bounded by the status cadence, not by any event.
    expect(resolvedAt).not.toBeNull()
    expect(resolvedAt!).toBeGreaterThanOrEqual(INCIDENT.terminalAtMs)
    expect(resolvedAt!).toBeLessThanOrEqual(INCIDENT.terminalAtMs + 1_500)
    expect(statusReads.some((at) => at >= INCIDENT.terminalAtMs && at <= resolvedAt!)).toBe(true)
    // Every status read before the DB terminal saw a still-running turn and
    // closed nothing: the 300s EOF alone never settles the turn.
    expect(statusReads.filter((at) => at < INCIDENT.proxyEofAtMs).length).toBeGreaterThan(0)
    expect(seen.at(-1)).toEqual({
      type: 'turn_terminal',
      turnId: INCIDENT.turnId,
      conversationId: INCIDENT.conversationId,
      status: 'done',
      lastSeq: -1,
      assistantMessageId: INCIDENT.assistantMessageId,
      continuationNeeded: false,
    })
    // Zero durable events: no cursor ever advanced and `emit` (which throws)
    // was never reached, so nothing was replayed as a sequenced row.
    expect(persistedCursors).toEqual([])
    expect(seen.every((event) => event.type === 'turn_snapshot' || event.type === 'turn_terminal')).toBe(true)
    // The observation endpoint was opened twice and never asked to run a turn.
    expect(ownerPromptRuns).toBe(0)

    await Promise.all(tails.map((active) => active.close()))
  })
})
