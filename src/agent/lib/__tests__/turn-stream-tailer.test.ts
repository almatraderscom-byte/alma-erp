import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTurnTail, type TurnTailIO } from '@/agent/lib/turn-stream-tailer'
import type { TurnEvent } from '@/agent/lib/turn-events'

/**
 * Reliability epic R-2 (handoff F-08): the durable-turn tailer must
 *   - deliver an event published between the replay query and the subscription
 *     exactly once,
 *   - heal a sequence gap from the durable log BEFORE applying the later event,
 *   - never silently accept `n+2` after a missing `n+1`,
 *   - keep the existing overlap dedupe / terminal / page-cap / fallback contracts.
 */

const ev = (seq: number, type = 'text_delta'): TurnEvent => ({ seq, type, payload: { type, seq } })

type Harness = {
  io: TurnTailIO & {
    getStatus: () => Promise<{
      turnId: string
      conversationId: string | null
      status: string
      lastSeq: number
      assistantMessageId: string | null
      continuationNeeded: boolean
    } | null>
  }
  emitted: number[]
  controls: unknown[]
  logs: Array<{ event: string; detail: Record<string, unknown> }>
  finished: () => boolean
  statusCalls: () => number
  /** Publish on the live channel (no-op until subscribed). */
  publish: (evt: TurnEvent) => void
  subscribed: () => boolean
  /** The abort signal the tailer handed to the last subscribe attempt. */
  subscribeSignal: () => AbortSignal | undefined
}

function harness(opts: {
  rows: () => TurnEvent[]
  subscribe?: 'ok' | 'none' | 'hang'
  /** Runs between the subscription being installed and the replay query. */
  betweenSubscribeAndReplay?: (h: Harness) => void
  replayError?: Error
  /** Fail this many catch-up (gap) queries before succeeding. */
  catchupFailures?: number
  status?: () => {
    turnId: string
    conversationId: string | null
    status: string
    lastSeq: number
    assistantMessageId: string | null
    continuationNeeded: boolean
  } | null
}): Harness {
  let onLive: ((evt: TurnEvent) => void) | null = null
  let subscribeSignal: AbortSignal | undefined
  let finished = false
  let statusCalls = 0
  const emitted: number[] = []
  const controls: unknown[] = []
  const logs: Harness['logs'] = []
  const h: Harness = {
    emitted,
    controls,
    logs,
    finished: () => finished,
    statusCalls: () => statusCalls,
    publish: (evt) => onLive?.(evt),
    subscribed: () => onLive != null,
    subscribeSignal: () => subscribeSignal,
    io: {
      async getReplay(afterSeq, limit) {
        if (opts.replayError) throw opts.replayError
        if (afterSeq >= 0 && (opts.catchupFailures ?? 0) > 0) {
          opts.catchupFailures = (opts.catchupFailures ?? 0) - 1
          throw new Error('catch-up db down')
        }
        // The race window: the publisher writes + publishes right after the
        // subscription exists but before this query resolves.
        if (opts.betweenSubscribeAndReplay && onLive) {
          const hook = opts.betweenSubscribeAndReplay
          opts.betweenSubscribeAndReplay = undefined
          hook(h)
        }
        const rows = opts.rows().filter((r) => r.seq > afterSeq).sort((a, b) => a.seq - b.seq)
        return typeof limit === 'number' ? rows.slice(0, limit) : rows
      },
      async subscribe(cb, signal) {
        subscribeSignal = signal
        if (opts.subscribe === 'none') return null
        if (opts.subscribe === 'hang') await new Promise(() => {})   // Redis unreachable: never settles
        onLive = cb
        return { close: async () => { onLive = null } }
      },
      async getStatus() {
        statusCalls += 1
        return opts.status?.() ?? {
          turnId: 't1',
          conversationId: 'c1',
          status: 'running',
          lastSeq: -1,
          assistantMessageId: null,
          continuationNeeded: false,
        }
      },
      poll(afterSeq, cb) {
        for (const r of opts.rows().filter((r) => r.seq > afterSeq)) cb(r)
        return { close: async () => {} }
      },
      emit(evt) { emitted.push(evt.seq) },
      control(payload) { controls.push(payload) },
      finish() { finished = true },
      log(event, detail) { logs.push({ event, detail }) },
    },
  }
  return h
}

const base = { turnId: 't1', afterSeq: -1, snapshotLastSeq: null, snapshotStatus: 'running' as const }

describe('turn-stream tailer — replay/subscribe ordering', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('delivers an event published between the replay query and the subscription exactly once', async () => {
    const rows: TurnEvent[] = [ev(0, 'conversation_id'), ev(1)]
    const h = harness({
      rows: () => rows,
      betweenSubscribeAndReplay: (hh) => {
        // Durable row lands AND the live publish fires while replay is in flight.
        rows.push(ev(2))
        hh.publish(ev(2))
      },
    })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    expect(h.subscribed()).toBe(true)
    expect(h.emitted).toEqual([0, 1, 2])   // seq 2 once — from replay OR buffer, never both
    h.publish(ev(3, 'done'))
    await tail.flush()
    expect(h.emitted).toEqual([0, 1, 2, 3])
    expect(h.finished()).toBe(true)
  })

  it('heals a gap from the durable log BEFORE applying the later live event', async () => {
    const rows: TurnEvent[] = [ev(0)]
    const h = harness({ rows: () => rows })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    // seq 1 was written but its publish was lost; seq 2 arrives live.
    rows.push(ev(1), ev(2))
    h.publish(ev(2))
    await tail.flush()
    expect(h.emitted).toEqual([0, 1, 2])
    expect(h.logs.map((l) => l.event)).toEqual(['gap_detected', 'replay_catchup'])
    expect(h.logs[0].detail).toMatchObject({ expectedSeq: 1, receivedSeq: 2 })
  })

  it('a transient catch-up failure is retried once, then healed normally', async () => {
    const rows: TurnEvent[] = [ev(0)]
    const h = harness({ rows: () => rows, catchupFailures: 1 })
    const tail = runTurnTail(h.io, { ...base, catchupRetryDelayMs: 1 })
    await tail.ready
    rows.push(ev(1), ev(2))
    h.publish(ev(2))
    await tail.flush()
    expect(h.emitted).toEqual([0, 1, 2])
    expect(h.logs.map((l) => l.event)).toEqual(['gap_detected', 'replay_catchup_failed', 'replay_catchup'])
  })

  it('a persistent catch-up failure closes the stream instead of skipping past the missing rows (Codex P1)', async () => {
    const rows: TurnEvent[] = [ev(0)]
    const h = harness({ rows: () => rows, catchupFailures: 99 })
    const tail = runTurnTail(h.io, { ...base, catchupRetryDelayMs: 1 })
    await tail.ready
    rows.push(ev(1), ev(2))
    h.publish(ev(2))
    await tail.flush()
    expect(h.emitted).toEqual([0])   // seq 2 was NOT accepted — the cursor never moved past 1
    expect(h.controls).toEqual([{ type: 'error', message: 'turn_replay_unavailable' }])
    expect(h.finished()).toBe(true)
  })

  it('a hole inside the catch-up range is reported, never silently healed (Codex P2)', async () => {
    const rows: TurnEvent[] = [ev(0)]
    const h = harness({ rows: () => rows })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    rows.push(ev(2), ev(3), ev(4))   // seq 1 never existed durably
    h.publish(ev(4))
    await tail.flush()
    expect(h.emitted).toEqual([0, 2, 3, 4])
    const unhealed = h.logs.filter((l) => l.event === 'gap_unhealed')
    expect(unhealed).toHaveLength(1)
    expect(unhealed[0].detail).toMatchObject({ expectedSeq: 1, receivedSeq: 2 })
  })

  it('an unhealable gap is logged loudly and the stream continues', async () => {
    const rows: TurnEvent[] = [ev(0)]
    const h = harness({ rows: () => rows })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    h.publish(ev(3))   // rows 1–2 never existed durably
    await tail.flush()
    expect(h.emitted).toEqual([0, 3])
    expect(h.logs.map((l) => l.event)).toEqual(['gap_detected', 'gap_unhealed'])
  })

  it('still dedupes the overlap between replay and live tail', async () => {
    const rows: TurnEvent[] = [ev(0), ev(1)]
    const h = harness({ rows: () => rows })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    h.publish(ev(1))   // raced duplicate
    h.publish(ev(2))
    await tail.flush()
    expect(h.emitted).toEqual([0, 1, 2])
    await tail.close()
  })

  it('a terminal event inside the replay closes the stream without tailing', async () => {
    const h = harness({ rows: () => [ev(0), ev(1, 'done'), ev(2)] })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    expect(h.emitted).toEqual([0, 1])
    expect(h.finished()).toBe(true)
  })

  it('a replay read failure ends the stream with an explicit error, never a mid-turn live-only tail (F-09)', async () => {
    const h = harness({ rows: () => [], replayError: new Error('db down') })
    const tail = runTurnTail(h.io, base)
    await tail.ready
    expect(h.controls).toEqual([{ type: 'error', message: 'turn_replay_unavailable' }])
    expect(h.finished()).toBe(true)
    expect(h.logs.map((l) => l.event)).toContain('replay_failed')
  })

  it('page-capped replay emits replay_continue from the cursor', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ev(i))
    const h = harness({ rows: () => rows })
    const tail = runTurnTail(h.io, { ...base, snapshotLastSeq: 5, replayPageSize: 3 })
    await tail.ready
    expect(h.emitted).toEqual([0, 1, 2])
    expect(h.controls).toEqual([{ type: 'replay_continue', afterSeq: 2 }])
    expect(h.finished()).toBe(true)
  })

  it('without a live channel it polls the durable log for a running turn and emits a canonical terminal for a settled one', async () => {
    const running = harness({ rows: () => [ev(0), ev(1)], subscribe: 'none' })
    const t1 = runTurnTail(running.io, base)
    await t1.ready
    expect(running.emitted).toEqual([0, 1])
    expect(running.finished()).toBe(false)

    const settled = harness({ rows: () => [ev(0)], subscribe: 'none' })
    const t2 = runTurnTail(settled.io, {
      ...base,
      snapshotStatus: 'done',
      snapshotConversationId: 'c1',
      snapshotLastSeq: 0,
      snapshotAssistantMessageId: 'assistant-1',
      snapshotContinuationNeeded: true,
    } as Parameters<typeof runTurnTail>[1])
    await t2.ready
    expect(settled.controls).toEqual([{
      type: 'turn_terminal',
      turnId: 't1',
      conversationId: 'c1',
      status: 'done',
      lastSeq: 0,
      assistantMessageId: 'assistant-1',
      continuationNeeded: true,
    }])
    expect(settled.finished()).toBe(true)
  })

  it('a zero-event turn that becomes terminal is discovered by exact-turn status polling', async () => {
    vi.useFakeTimers()
    let status = 'running'
    const h = harness({
      rows: () => [],
      subscribe: 'none',
      status: () => ({
        turnId: 't1', conversationId: 'c1', status, lastSeq: -1,
        assistantMessageId: status === 'running' ? null : 'assistant-zero',
        continuationNeeded: status === 'done',
      }),
    })
    const tail = runTurnTail(h.io, { ...base, statusPollIntervalMs: 1000 } as Parameters<typeof runTurnTail>[1])
    await tail.ready
    expect(h.finished()).toBe(false)

    status = 'done'
    await vi.advanceTimersByTimeAsync(1000)
    await tail.flush()

    expect(h.controls).toEqual([{
      type: 'turn_terminal', turnId: 't1', conversationId: 'c1',
      status: 'done', lastSeq: -1,
      assistantMessageId: 'assistant-zero', continuationNeeded: true,
    }])
    expect(h.finished()).toBe(true)
  })

  it('terminal status catches up durable rows before emitting its unsequenced control', async () => {
    vi.useFakeTimers()
    const rows: TurnEvent[] = []
    let status = 'running'
    const h = harness({
      rows: () => rows,
      subscribe: 'none',
      status: () => ({
        turnId: 't1', conversationId: 'c1',
        status, lastSeq: status === 'running' ? -1 : 0,
        assistantMessageId: status === 'running' ? null : 'assistant-caught-up',
        continuationNeeded: false,
      }),
    })
    const tail = runTurnTail(h.io, {
      ...base,
      statusPollIntervalMs: 1000,
      terminalCatchupRetryDelayMs: 1,
    } as Parameters<typeof runTurnTail>[1])
    await tail.ready

    rows.push(ev(0, 'text_delta'))
    status = 'error'
    await vi.advanceTimersByTimeAsync(1001)
    await tail.flush()

    expect(h.emitted).toEqual([0])
    expect(h.controls).toEqual([{
      type: 'turn_terminal', turnId: 't1', conversationId: 'c1',
      status: 'error', lastSeq: 0,
      assistantMessageId: 'assistant-caught-up', continuationNeeded: false,
    }])
    expect(h.finished()).toBe(true)
  })

  it('never advertises a terminal cursor past a lagged durable row it has not emitted', async () => {
    vi.useFakeTimers()
    const rows: TurnEvent[] = []
    let status = 'running'
    const h = harness({
      rows: () => rows,
      subscribe: 'none',
      status: () => ({
        turnId: 't1', conversationId: 'c1', status,
        lastSeq: status === 'running' ? -1 : 1,
        assistantMessageId: status === 'running' ? null : 'assistant-lagged',
        continuationNeeded: false,
      }),
    })
    const tail = runTurnTail(h.io, {
      ...base,
      statusPollIntervalMs: 1000,
      terminalCatchupRetryDelayMs: 1,
    } as Parameters<typeof runTurnTail>[1])
    await tail.ready

    status = 'done'
    await vi.advanceTimersByTimeAsync(1001)
    await tail.flush()
    expect(h.controls).toEqual([])
    expect(h.finished()).toBe(false)
    expect(h.logs.map((entry) => entry.event)).toContain('terminal_catchup_pending')

    rows.push(ev(0, 'text_delta'), ev(1, 'text_delta'))
    await vi.advanceTimersByTimeAsync(1000)
    await tail.flush()
    expect(h.emitted).toEqual([0, 1])
    expect(h.controls).toEqual([{
      type: 'turn_terminal', turnId: 't1', conversationId: 'c1',
      status: 'done', lastSeq: 1,
      assistantMessageId: 'assistant-lagged', continuationNeeded: false,
    }])
  })

  it('reconnects the same zero-event turn at 300000ms and observes DB done at 473871ms promptly', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const terminalAt = 473_871
    const status = () => ({
      turnId: 't1',
      conversationId: 'c1',
      status: Date.now() >= terminalAt ? 'done' : 'running',
      lastSeq: -1,
      assistantMessageId: Date.now() >= terminalAt ? 'assistant-474s' : null,
      continuationNeeded: false,
    })

    const first = harness({ rows: () => [], subscribe: 'none', status })
    const firstTail = runTurnTail(first.io, {
      ...base, statusPollIntervalMs: 1000,
    } as Parameters<typeof runTurnTail>[1])
    await firstTail.ready
    await vi.advanceTimersByTimeAsync(300_000)
    await firstTail.close() // serverless stream deadline / transport disconnect

    const reconnected = harness({ rows: () => [], subscribe: 'none', status })
    const secondTail = runTurnTail(reconnected.io, {
      ...base, statusPollIntervalMs: 1000,
    } as Parameters<typeof runTurnTail>[1])
    await secondTail.ready
    await vi.advanceTimersByTimeAsync(173_871)
    expect(reconnected.finished()).toBe(false)
    await vi.advanceTimersByTimeAsync(129) // next 1s exact-turn status tick at 474000ms
    await secondTail.flush()

    expect(Date.now()).toBe(474_000)
    expect(reconnected.controls).toEqual([{
      type: 'turn_terminal', turnId: 't1', conversationId: 'c1',
      status: 'done', lastSeq: -1,
      assistantMessageId: 'assistant-474s', continuationNeeded: false,
    }])
    expect(reconnected.finished()).toBe(true)
    expect(first.statusCalls() + reconnected.statusCalls()).toBeGreaterThan(0)
  })

  it('an unreachable live channel cannot hold back the durable replay: deadline → polling fallback (Codex P1)', async () => {
    const h = harness({ rows: () => [ev(0), ev(1)], subscribe: 'hang' })
    const tail = runTurnTail(h.io, { ...base, subscribeTimeoutMs: 20 })
    await tail.ready
    expect(h.emitted).toEqual([0, 1])   // replayed + polled despite the hung subscribe
    expect(h.logs.map((l) => l.event)).toContain('subscribe_timeout')
    expect(h.finished()).toBe(false)
    // The attempt is torn down, not left reconnecting forever (Codex P1 r4).
    expect(h.subscribeSignal()?.aborted).toBe(true)
  })

  it('a subscription that won the race is never aborted', async () => {
    const h = harness({ rows: () => [ev(0)] })
    const tail = runTurnTail(h.io, { ...base, subscribeTimeoutMs: 10 })
    await tail.ready
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.subscribeSignal()?.aborted).toBe(false)
  })

  it('a subscription that won the race keeps delivering after the deadline would have fired (Codex P1 r3)', async () => {
    const h = harness({ rows: () => [ev(0)] })
    const tail = runTurnTail(h.io, { ...base, subscribeTimeoutMs: 10 })
    await tail.ready
    expect(h.subscribed()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))   // well past the 10 ms deadline
    h.publish(ev(1))
    h.publish(ev(2))
    await tail.flush()
    expect(h.emitted).toEqual([0, 1, 2])
    expect(h.logs.map((l) => l.event)).not.toContain('subscribe_timeout')
    expect(h.finished()).toBe(false)
  })

  it('resumes strictly after the client cursor', async () => {
    const h = harness({ rows: () => [ev(0), ev(1), ev(2), ev(3)] })
    const tail = runTurnTail(h.io, { ...base, afterSeq: 1 })
    await tail.ready
    expect(h.emitted).toEqual([2, 3])
  })
})
