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

export interface TurnTailStatusSnapshot {
  turnId: string
  conversationId: string | null
  status: string
  lastSeq: number | null
  assistantMessageId: string | null
  continuationNeeded: boolean
}

export interface TurnTailIO {
  /** Durable rows newer than `afterSeq`, oldest first, at most `limit`. */
  getReplay(afterSeq: number, limit?: number): Promise<TurnEvent[]>
  /** Live channel subscription; null when no live channel is configured. */
  /**
   * `signal` aborts an attempt that outlives the subscription deadline: an
   * ioredis client with maxRetriesPerRequest:null reconnects forever, so a
   * `.then(close)` on the pending promise would never run (Codex P1 #836 r4).
   */
  subscribe(onEvent: (evt: TurnEvent) => void, signal?: AbortSignal): Promise<{ close: () => Promise<void> } | null>
  /** Exact lifecycle snapshot for THIS turn (never conversation-latest). */
  getStatus(): Promise<TurnTailStatusSnapshot | null>
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
  snapshotConversationId?: string | null
  snapshotAssistantMessageId?: string | null
  snapshotContinuationNeeded?: boolean
  replayPageSize?: number
  /** Delay before the single catch-up retry (tests shorten it). */
  catchupRetryDelayMs?: number
  /**
   * Upper bound on the pre-replay subscription attempt. An unreachable Redis
   * (ioredis with maxRetriesPerRequest: null keeps reconnecting) must not hold
   * back the durable replay and the polling fallback (Codex P1 #836).
   */
  subscribeTimeoutMs?: number
  /** Exact-turn lifecycle cadence; runs even while Redis live-tail is healthy. */
  statusPollIntervalMs?: number
  /** One consistency retry when terminal.lastSeq is ahead of readable rows. */
  terminalCatchupRetryDelayMs?: number
  /** Bound for a permanently missing durable row before status-only settlement. */
  terminalCatchupMaxChecks?: number
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
  let subscribeTimedOut = false
  const buffered: TurnEvent[] = []
  let chain: Promise<void> = Promise.resolve()
  let statusChain: Promise<void> = Promise.resolve()
  let statusTimer: ReturnType<typeof setInterval> | null = null
  let terminalLagChecks = 0
  const log = io.log ?? (() => {})

  const finish = () => {
    if (closed) return
    closed = true
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
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

  /**
   * Heal a gap before `evt`: fetch the durable rows between lastSeq and evt.seq.
   * Returns false when the stream was closed (catch-up unavailable) and the
   * later event must NOT be applied.
   */
  const healGap = async (evt: TurnEvent): Promise<boolean> => {
    const expected = dedup.lastSeq + 1
    if (evt.seq <= expected) return true
    log('gap_detected', { turnId: opts.turnId, expectedSeq: expected, receivedSeq: evt.seq })
    let missing: TurnEvent[] | null = null
    for (let attempt = 0; attempt < 2 && missing == null; attempt++) {
      try {
        missing = await io.getReplay(dedup.lastSeq, evt.seq - dedup.lastSeq - 1)
      } catch (err) {
        log('replay_catchup_failed', { turnId: opts.turnId, attempt: attempt + 1, error: err instanceof Error ? err.message : String(err) })
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, opts.catchupRetryDelayMs ?? 250))
      }
    }
    if (missing == null) {
      // The durable log is the only complete source. Accepting the later event
      // would move the cursor past rows that may exist and reject them forever
      // once the database recovers (Codex P1 #836) — close loudly instead.
      io.control({ type: 'error', message: 'turn_replay_unavailable' })
      finish()
      return false
    }
    let healed = 0
    for (const row of missing) {
      if (row.seq >= evt.seq) break
      if (row.seq !== dedup.lastSeq + 1) {
        // Catch-up rows must be contiguous: a hole inside the fetched range is
        // a lost durable write, reported per row (Codex P2 #836).
        log('gap_unhealed', { turnId: opts.turnId, expectedSeq: dedup.lastSeq + 1, receivedSeq: row.seq })
      }
      if (accept(row)) return false
      healed += 1
    }
    if (healed > 0) log('replay_catchup', { turnId: opts.turnId, healed, upTo: dedup.lastSeq })
    if (dedup.lastSeq + 1 < evt.seq) {
      // Rows genuinely absent (durable write lost). Continue — the client still
      // gets everything that exists — but say so loudly instead of pretending.
      log('gap_unhealed', { turnId: opts.turnId, expectedSeq: dedup.lastSeq + 1, receivedSeq: evt.seq })
    }
    return true
  }

  const applyLive = (evt: TurnEvent) => {
    chain = chain
      .then(async () => {
        if (closed) return
        if (!(await healGap(evt))) return
        accept(evt)
      })
      .catch((err) => {
        log('live_apply_failed', { turnId: opts.turnId, error: err instanceof Error ? err.message : String(err) })
      })
  }

  const onLive = (evt: TurnEvent) => {
    if (closed || subscribeTimedOut) return
    if (replaying) {
      buffered.push(evt)
      return
    }
    applyLive(evt)
  }

  const isTerminalStatus = (status: string | null | undefined) =>
    status === 'done' || status === 'error' || status === 'canceled'

  /**
   * A lifecycle row may become terminal before the worker's mirrored terminal
   * event reaches the durable log. Read every currently durable row first; if
   * status.lastSeq says a row is still missing, retry that read once. Only then
   * emit the unsequenced status control and close.
   */
  const settleFromStatus = async (status: TurnTailStatusSnapshot): Promise<boolean> => {
    if (closed || !isTerminalStatus(status.status)) return closed
    if (status.turnId !== opts.turnId) {
      log('status_turn_mismatch', {
        turnId: opts.turnId,
        receivedTurnId: status.turnId,
      })
      return false
    }

    const targetLastSeq = Number.isFinite(status.lastSeq) ? Number(status.lastSeq) : -1
    let consistencyRetryUsed = false
    while (!closed) {
      let rows: TurnEvent[]
      try {
        rows = await io.getReplay(dedup.lastSeq, pageSize)
      } catch (err) {
        log('terminal_catchup_failed', {
          turnId: opts.turnId,
          error: err instanceof Error ? err.message : String(err),
        })
        break
      }
      for (const evt of rows) {
        if (accept(evt)) return true
      }
      if (rows.length >= pageSize) continue
      if (dedup.lastSeq < targetLastSeq && !consistencyRetryUsed) {
        consistencyRetryUsed = true
        await new Promise((resolve) => setTimeout(
          resolve,
          opts.terminalCatchupRetryDelayMs ?? 100,
        ))
        continue
      }
      break
    }
    if (closed) return true

    if (dedup.lastSeq < targetLastSeq) {
      terminalLagChecks += 1
      log('terminal_catchup_pending', {
        turnId: opts.turnId,
        expectedThroughSeq: targetLastSeq,
        observedSeq: dedup.lastSeq,
        check: terminalLagChecks,
      })
      // Keep this exact-turn stream open for another status tick while a row
      // the lifecycle snapshot says exists is still unreadable. If the durable
      // hole persists, settle from DB status without advancing the client cursor
      // past data it never saw; an exact-cursor reconnect can still request it.
      if (terminalLagChecks < (opts.terminalCatchupMaxChecks ?? 3)) return false
    } else {
      terminalLagChecks = 0
    }

    io.control({
      type: 'turn_terminal',
      turnId: status.turnId,
      conversationId: status.conversationId,
      status: status.status,
      lastSeq: dedup.lastSeq,
      assistantMessageId: status.assistantMessageId,
      continuationNeeded: status.status === 'done' && status.continuationNeeded === true,
    })
    finish()
    return true
  }

  const scheduleStatusCheck = () => {
    statusChain = statusChain
      .then(async () => {
        if (closed) return
        let status: TurnTailStatusSnapshot | null = null
        try {
          status = await io.getStatus()
        } catch (err) {
          log('status_poll_failed', {
            turnId: opts.turnId,
            error: err instanceof Error ? err.message : String(err),
          })
          return
        }
        if (!status || !isTerminalStatus(status.status)) return
        chain = chain.then(async () => { await settleFromStatus(status!) })
        await chain
      })
      .catch((err) => {
        log('status_apply_failed', {
          turnId: opts.turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return statusChain
  }

  const ready = (async () => {
    // 1) Subscribe FIRST so nothing published during the replay query is lost —
    //    but never wait on it longer than the deadline: already-persisted rows
    //    must flow even while the live channel is down.
    const subscribeTimeoutMs = opts.subscribeTimeoutMs ?? 1500
    const subscribeAbort = new AbortController()
    try {
      const attempt = io.subscribe(onLive, subscribeAbort.signal)
      const deadlineTimer: { id?: ReturnType<typeof setTimeout> } = {}
      const deadline = new Promise<null>((resolve) => {
        deadlineTimer.id = setTimeout(() => { subscribeTimedOut = true; resolve(null) }, subscribeTimeoutMs)
      })
      try {
        sub = await Promise.race([attempt, deadline])
      } finally {
        // A subscription that won the race must not be disowned by a deadline
        // still ticking (Codex P1 #836 r3): it flipped `subscribeTimedOut` 1.5 s
        // later, every live event was dropped and — `sub` being set — polling
        // never started: a permanently frozen tail.
        if (deadlineTimer.id) clearTimeout(deadlineTimer.id)
      }
      if (subscribeTimedOut) {
        log('subscribe_timeout', { turnId: opts.turnId, afterMs: subscribeTimeoutMs })
        // Tear the attempt down NOW: an unreachable Redis keeps the client
        // reconnecting forever, so waiting for the promise would leak one
        // client per stream for the whole outage. A late success (closed by
        // the handler below) must not become a second delivery path either.
        subscribeAbort.abort()
        void attempt.then((late) => { void late?.close() }).catch(() => {})
        sub = null
      }
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

    // A terminal connection snapshot is already exact-turn DB truth. It still
    // goes through terminal catch-up so durable rows precede the control frame.
    if (isTerminalStatus(opts.snapshotStatus)) {
      await settleFromStatus({
        turnId: opts.turnId,
        conversationId: opts.snapshotConversationId ?? null,
        status: opts.snapshotStatus!,
        lastSeq: opts.snapshotLastSeq,
        assistantMessageId: opts.snapshotAssistantMessageId ?? null,
        continuationNeeded: opts.snapshotContinuationNeeded === true,
      })
      if (closed) return
    }

    if (!sub) {
      // No live channel: the durable log is written BEFORE each publish, so
      // poll it instead (~1s). Exact status polling below is independent: a
      // zero-event terminal turn must close even when no event row ever lands.
      sub = io.poll(dedup.lastSeq, (evt) => {
        if (closed) return
        accept(evt)
      })
    }

    // Status is authoritative lifecycle truth and is polled even with a healthy
    // Redis subscription: a terminal transition can legitimately have zero
    // event rows (or a lost terminal publish).
    await scheduleStatusCheck()
    if (closed) return
    statusTimer = setInterval(
      () => { void scheduleStatusCheck() },
      opts.statusPollIntervalMs ?? 1000,
    )
  })()

  return {
    ready,
    flush: async () => {
      await statusChain.catch(() => {})
      await chain.catch(() => {})
    },
    close: async () => {
      finish()
      await statusChain.catch(() => {})
      await chain.catch(() => {})
    },
  }
}
