/**
 * Durable-turn tailer (handoff F-08 — reliability epic R-2).
 *
 * The stream endpoint used to REPLAY the durable log first and only then
 * SUBSCRIBE to the live channel. An event written + published in that window
 * was delivered to nobody on that connection, and the seq deduper accepted any
 * larger seq, so a missing `n+1` followed by `n+2` was silently skipped — a
 * lost `text_delta` before a received `tool_start` is one more road to a
 * tool-only transcript.
 *
 * This pure orchestrator fixes both, with the I/O injected so it is unit-tested
 * without Redis or Prisma:
 *   1. subscribe FIRST; live events arriving during replay are buffered;
 *   2. replay the durable log; then drain the buffer through the deduper;
 *   3. every later live event is applied in order on a serial chain, and a
 *      gap (`seq > lastSeq + 1`) is healed by fetching the missing durable
 *      range BEFORE the event is emitted. An unhealable gap (rows genuinely
 *      absent) is logged and the stream continues — never silently accepted.
 */
import { createSeqDeduper, isTerminalEventType, type TurnEvent } from '@/agent/lib/turn-events'

export interface TurnTailIO {
  /** Durable rows newer than `afterSeq`, oldest first, at most `limit`. */
  getReplay(afterSeq: number, limit?: number): Promise<TurnEvent[]>
  /** Live channel subscription; null when no live channel is configured. */
  subscribe(onEvent: (evt: TurnEvent) => void): Promise<{ close: () => Promise<void> } | null>
  /** Database polling fallback when there is no live channel. */
  poll(afterSeq: number, onEvent: (evt: TurnEvent) => void): { close: () => Promise<void> }
  /** Emit one accepted event to the client. */
  emit(evt: TurnEvent): void
  /** Emit a control frame that is NOT part of the seq space (replay_continue / error). */
  control(payload: unknown): void
  /** Close the client stream. */
  finish(): void
  /** Structured telemetry sink (gap_detected / replay_catchup / gap_unhealed). */
  log?(event: string, detail: Record<string, unknown>): void
}

export interface TurnTailOptions {
  turnId: string
  afterSeq: number
  /** Snapshot facts the endpoint already fetched. */
  snapshotLastSeq: number | null
  snapshotStatus: string | null
  replayPageSize?: number
}

export interface TurnTailHandle {
  close(): Promise<void>
  /** Resolves when the orchestrator has finished its initial replay + drain. */
  ready: Promise<void>
  /** Resolves once every live event received so far has been applied (tests). */
  flush(): Promise<void>
}

export function runTurnTail(io: TurnTailIO, opts: TurnTailOptions): TurnTailHandle {
  const pageSize = opts.replayPageSize ?? 5000
  const dedup = createSeqDeduper(opts.afterSeq)
  let closed = false
  let sub: { close: () => Promise<void> } | null = null
  let replaying = true
  const buffered: TurnEvent[] = []
  let chain: Promise<void> = Promise.resolve()
  const log = io.log ?? (() => {})

  const finish = () => {
    if (closed) return
    closed = true
    io.finish()
    void sub?.close()
  }

  /** Accept + emit one event; returns true when it ended the stream. */
  const accept = (evt: TurnEvent): boolean => {
    if (closed) return true
    if (!dedup.accept(evt.seq)) return false
    io.emit(evt)
    if (isTerminalEventType(evt.type)) {
      finish()
      return true
    }
    return false
  }

  /** Heal a gap before `evt`: fetch the durable rows between lastSeq and evt.seq. */
  const healGap = async (evt: TurnEvent) => {
    const expected = dedup.lastSeq + 1
    if (evt.seq <= expected) return
    log('gap_detected', { turnId: opts.turnId, expectedSeq: expected, receivedSeq: evt.seq })
    let missing: TurnEvent[] = []
    try {
      missing = await io.getReplay(dedup.lastSeq, evt.seq - dedup.lastSeq - 1)
    } catch (err) {
      log('replay_catchup_failed', { turnId: opts.turnId, error: err instanceof Error ? err.message : String(err) })
    }
    let healed = 0
    for (const row of missing) {
      if (row.seq >= evt.seq) break
      if (accept(row)) return
      healed += 1
    }
    if (healed > 0) log('replay_catchup', { turnId: opts.turnId, healed, upTo: dedup.lastSeq })
    if (dedup.lastSeq + 1 < evt.seq) {
      // Rows genuinely absent (durable write lost). Continue — the client still
      // gets everything that exists — but say so loudly instead of pretending.
      log('gap_unhealed', { turnId: opts.turnId, expectedSeq: dedup.lastSeq + 1, receivedSeq: evt.seq })
    }
  }

  const applyLive = (evt: TurnEvent) => {
    chain = chain
      .then(async () => {
        if (closed) return
        await healGap(evt)
        accept(evt)
      })
      .catch((err) => {
        log('live_apply_failed', { turnId: opts.turnId, error: err instanceof Error ? err.message : String(err) })
      })
  }

  const onLive = (evt: TurnEvent) => {
    if (closed) return
    if (replaying) {
      buffered.push(evt)
      return
    }
    applyLive(evt)
  }

  const ready = (async () => {
    // 1) Subscribe FIRST so nothing published during the replay query is lost.
    try {
      sub = await io.subscribe(onLive)
    } catch (err) {
      log('subscribe_failed', { turnId: opts.turnId, error: err instanceof Error ? err.message : String(err) })
      sub = null
    }
    if (closed) return

    // 2) Replay the durable log after the cursor. Terminal replay closes clean.
    let replay: TurnEvent[] = []
    try {
      replay = await io.getReplay(dedup.lastSeq, pageSize)
    } catch (err) {
      // Replay is the only complete source of truth. Failing to read it must
      // not degrade into a live-only tail that starts mid-turn (F-09).
      log('replay_failed', { turnId: opts.turnId, error: err instanceof Error ? err.message : String(err) })
      io.control({ type: 'error', message: 'turn_replay_unavailable' })
      finish()
      return
    }
    for (const evt of replay) {
      if (accept(evt)) return
    }

    // A page-capped replay that didn't reach the tail: tell the client to
    // continue from the cursor instead of silently skipping ahead.
    if (
      replay.length >= pageSize
      && opts.snapshotLastSeq != null
      && opts.snapshotLastSeq > dedup.lastSeq
    ) {
      io.control({ type: 'replay_continue', afterSeq: dedup.lastSeq })
      finish()
      return
    }

    // 3) Drain what the live channel delivered while we replayed — each event
    //    through the same gap-healing path, in order.
    replaying = false
    const pending = buffered.splice(0)
    for (const evt of pending) applyLive(evt)
    await chain
    if (closed) return

    if (!sub) {
      // No live channel: the durable log is written BEFORE each publish, so
      // poll it instead (~1s) — but only for a turn that is still running.
      if (opts.snapshotStatus !== 'running') {
        io.control({ type: 'error', message: 'turn_stream_unavailable' })
        finish()
        return
      }
      sub = io.poll(dedup.lastSeq, (evt) => {
        if (closed) return
        accept(evt)
      })
    }
  })()

  return {
    ready,
    flush: () => chain.catch(() => {}),
    close: async () => {
      finish()
      await chain.catch(() => {})
    },
  }
}
