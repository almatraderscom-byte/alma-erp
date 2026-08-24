import { IncrementalSseParser, type ParsedSseEvent } from '@/agent/lib/sse-parser'

export type JsonSseEvent = Record<string, unknown> & { type?: unknown }

export interface ConsumeJsonSseOptions {
  response: Response
  onEvent(event: JsonSseEvent): void | Promise<void>
}

export interface TailExactTurnOptions {
  turnId: string
  conversationId?: string | null
  initialAfterSeq?: number
  open(turnId: string, afterSeq: number, signal?: AbortSignal): Promise<Response>
  onEvent(event: JsonSseEvent): void | Promise<void>
  onCursor?(lastSeq: number): void
  signal?: AbortSignal
  /** Number of transport reconnects after the initial connection. */
  maxReconnects?: number
  reconnectDelayMs?: number
  sleep?(delayMs: number): Promise<void>
}

export interface TailExactTurnResult {
  lastSeq: number
  terminal: true
}

export interface PersistedDurableTurn {
  turnId: string
  /** Exact source conversation that owns the turn and assistant row. */
  conversationId: string
  /** UI continuation after post-terminal compaction; source remains unchanged. */
  activeConversationId?: string
  lastSeq: number
}

export interface DurableTurnStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type ExactTurnObserver = { turnId: string; controller: AbortController }
export type ExactTurnObserverSlot = { current: ExactTurnObserver | null }

/** Navigation stops only this socket; promise.finally still owns global cleanup. */
export function suspendExactTurnObserverForNavigation(
  slot: ExactTurnObserverSlot,
  controller: AbortController,
) {
  if (slot.current?.controller === controller) controller.abort()
}

/** Release only the observer that is actually finishing (never a newer turn). */
export function releaseExactTurnObserver(
  slot: ExactTurnObserverSlot,
  controller: AbortController,
): boolean {
  if (slot.current?.controller !== controller) return false
  slot.current = null
  return true
}

const DURABLE_TURN_STORAGE_KEY = 'alma:durable-turn:v1'

export function loadPersistedDurableTurn(storage: DurableTurnStorage): PersistedDurableTurn | null {
  try {
    const raw = storage.getItem(DURABLE_TURN_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedDurableTurn>
    if (typeof value.turnId !== 'string' || value.turnId.length === 0) return null
    if (typeof value.conversationId !== 'string' || value.conversationId.length === 0) return null
    if (value.activeConversationId != null && (
      typeof value.activeConversationId !== 'string' || value.activeConversationId.length === 0
    )) return null
    if (!Number.isSafeInteger(value.lastSeq) || (value.lastSeq as number) < -1) return null
    return {
      turnId: value.turnId,
      conversationId: value.conversationId,
      ...(value.activeConversationId ? { activeConversationId: value.activeConversationId } : {}),
      lastSeq: value.lastSeq as number,
    }
  } catch {
    return null
  }
}

export function savePersistedDurableTurn(
  storage: DurableTurnStorage,
  descriptor: PersistedDurableTurn,
) {
  try {
    storage.setItem(DURABLE_TURN_STORAGE_KEY, JSON.stringify(descriptor))
  } catch { /* storage disabled/full: the active in-memory tail still works */ }
}

export function clearPersistedDurableTurn(storage: DurableTurnStorage, exactTurnId?: string) {
  try {
    if (exactTurnId) {
      const current = loadPersistedDurableTurn(storage)
      if (current?.turnId !== exactTurnId) return
    }
    storage.removeItem(DURABLE_TURN_STORAGE_KEY)
  } catch { /* best-effort client recovery hint */ }
}

export async function reconcilePersistedDurableTurn<Row extends { id: string }>(opts: {
  storage: DurableTurnStorage
  turnId: string
  assistantMessageId: string | null
  /** Error/canceled turns are valid terminals even when they persist no reply. */
  allowNoAssistantRow: boolean
  /** @deprecated Successful done turns never clear without their exact row. */
  allowNoAssistantRowAfterAttempts?: boolean
  readRows(): Promise<Row[]>
  onRows?(rows: Row[]): void | Promise<void>
  attempts?: number
  sleep?(delayMs: number): Promise<void>
}): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 6)
  const sleep = opts.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const rows = await opts.readRows()
      await opts.onRows?.(rows)
      const exactRowObserved = opts.assistantMessageId != null
        && rows.some((row) => row.id === opts.assistantMessageId)
      if (exactRowObserved || (opts.allowNoAssistantRow && opts.assistantMessageId == null)) {
        // Clearing is deliberately last: a process kill after terminal but
        // before exact-row reconciliation must leave cold recovery armed.
        clearPersistedDurableTurn(opts.storage, opts.turnId)
        return true
      }
    } catch {
      // Commit/read-replica/network lag: retain the descriptor and retry.
    }
    if (attempt + 1 < attempts) await sleep(250)
  }
  return false
}

/**
 * One-shot state for direct→durable handoff. A direct stream has no sequence
 * cursor, so the first durable snapshot must reset its optimistic projection
 * before replay; snapshots on cursor reconnects must leave rebuilt UI intact.
 */
export function createDurableReplayResetGate(resetDirectProjection: boolean) {
  let pending = resetDirectProjection
  return {
    shouldReset(event: JsonSseEvent): boolean {
      if (!pending || event.type !== 'turn_snapshot') return false
      pending = false
      return true
    },
  }
}

/** Keep exact-turn storage/reconciliation on its source conversation after UI compaction. */
export function createExactTurnConversationBinding(initialConversationId: string | null) {
  let sourceConversationId = initialConversationId
  let activeConversationId = initialConversationId
  return {
    observeSource(conversationId: string) {
      if (!sourceConversationId) sourceConversationId = conversationId
      activeConversationId = conversationId
    },
    compactTo(conversationId: string) {
      activeConversationId = conversationId
    },
    get sourceConversationId() { return sourceConversationId },
    get activeConversationId() { return activeConversationId },
  }
}

type StreamReadResult = {
  lastSeq: number
  terminal: boolean
}

export class SseEventConsumerError extends Error {
  constructor(readonly source: unknown) {
    super(source instanceof Error ? source.message : String(source))
    this.name = 'SseEventConsumerError'
  }
}

export const isRetryableRecoveryControl = (event: JsonSseEvent) =>
  event.type === 'error'
  && (event.message === 'turn_snapshot_unavailable' || event.message === 'turn_replay_unavailable')

const terminalEvent = (event: JsonSseEvent) =>
  event.type === 'done'
  || (event.type === 'error' && !isRetryableRecoveryControl(event))
  || event.type === 'canceled'
  || event.type === 'turn_terminal'

function numericEventId(event: ParsedSseEvent): number | null {
  if (event.id == null || !/^\d+$/.test(event.id)) return null
  const value = Number.parseInt(event.id, 10)
  return Number.isSafeInteger(value) ? value : null
}

function assertExactIdentity(
  event: JsonSseEvent,
  turnId: string,
  conversationId: string | null | undefined,
) {
  if (event.type === 'turn_id' && typeof event.id === 'string' && event.id !== turnId) {
    throw new Error('turn_stream_identity_mismatch')
  }
  if (event.type !== 'turn_snapshot' && event.type !== 'turn_terminal') return
  if (event.turnId !== turnId) throw new Error('turn_stream_identity_mismatch')
  if (conversationId && event.conversationId !== conversationId) {
    throw new Error('turn_stream_identity_mismatch')
  }
}

async function readResponse(
  response: Response,
  opts: {
    lastSeq: number
    turnId?: string
    conversationId?: string | null
    onEvent(event: JsonSseEvent): void | Promise<void>
    onCursor?(lastSeq: number): void
    stopOnTerminal: boolean
  },
): Promise<StreamReadResult> {
  if (!response.ok) throw new Error(`turn_stream_http_${response.status}`)
  if (!response.body) throw new Error('turn_stream_body_missing')

  const parser = new IncrementalSseParser()
  const reader = response.body.getReader()
  let lastSeq = opts.lastSeq
  let terminal = false

  const apply = async (parsed: ParsedSseEvent) => {
    let event: JsonSseEvent
    try {
      event = JSON.parse(parsed.data) as JsonSseEvent
    } catch {
      return
    }

    if (opts.turnId) assertExactIdentity(event, opts.turnId, opts.conversationId)

    const seq = numericEventId(parsed)
    const isUnsequencedControl = event.type === 'turn_terminal'
      || event.type === 'turn_snapshot'
      || event.type === 'replay_continue'
    if (seq != null && seq <= lastSeq && !isUnsequencedControl) return

    try {
      await opts.onEvent(event)
    } catch (error) {
      // A React reducer/callback failure is deterministic application code, not
      // a transport cut. Retrying would replay the same event and duplicate any
      // side effects that happened before the callback threw.
      throw new SseEventConsumerError(error)
    }
    // A durable cursor means the consumer successfully applied this row. Save
    // it only after the callback, otherwise a reducer failure plus cold reload
    // would skip the unapplied event forever.
    if (seq != null && seq > lastSeq) {
      lastSeq = seq
      opts.onCursor?.(lastSeq)
    }
    terminal ||= terminalEvent(event)
  }

  try {
    while (!terminal || !opts.stopOnTerminal) {
      const { done, value } = await reader.read()
      if (value) {
        for (const parsed of parser.push(value)) await apply(parsed)
      }
      if (done) {
        for (const parsed of parser.finish()) await apply(parsed)
        break
      }
    }
  } finally {
    if (terminal && opts.stopOnTerminal) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  return { lastSeq, terminal }
}

/** Consume one JSON-over-SSE response using the same byte-safe parser as tails. */
export async function consumeJsonSseResponse(opts: ConsumeJsonSseOptions): Promise<void> {
  await readResponse(opts.response, {
    lastSeq: -1,
    onEvent: opts.onEvent,
    stopOnTerminal: false,
  })
}

/**
 * Follow one durable turn across clean proxy EOFs or transient network failures.
 * Reconnects only the supplied exact turn and carries the last actually observed
 * `id:` cursor; it never creates, reruns, or switches to conversation-latest.
 */
export async function tailExactTurnStream(opts: TailExactTurnOptions): Promise<TailExactTurnResult> {
  let lastSeq = Number.isSafeInteger(opts.initialAfterSeq) && (opts.initialAfterSeq ?? -1) >= 0
    ? (opts.initialAfterSeq as number)
    : -1
  const maxReconnects = opts.maxReconnects ?? 32
  const reconnectDelayMs = opts.reconnectDelayMs ?? 250
  const sleep = opts.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  let reconnects = 0

  while (true) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError')
    try {
      const response = await opts.open(opts.turnId, lastSeq, opts.signal)
      const result = await readResponse(response, {
        lastSeq,
        turnId: opts.turnId,
        conversationId: opts.conversationId,
        onEvent: opts.onEvent,
        onCursor: opts.onCursor,
        stopOnTerminal: true,
      })
      lastSeq = result.lastSeq
      if (result.terminal) return { lastSeq, terminal: true }
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error
      if (error instanceof SseEventConsumerError) throw error
      if (error instanceof Error && error.message === 'turn_stream_identity_mismatch') throw error
      if (error instanceof Error && /^turn_stream_http_(400|401|403|404)$/.test(error.message)) throw error
    }

    if (reconnects >= maxReconnects) throw new Error('turn_stream_reconnect_exhausted')
    reconnects += 1
    // Immediate failures (offline DNS, radio transition) otherwise burn a fixed
    // retry count in a few seconds. This bounded backoff gives the default 32
    // reconnects a ~116s recovery window while clean 300s proxy EOFs reconnect
    // after only 250ms.
    const delayMs = Math.min(reconnectDelayMs * (2 ** Math.min(reconnects - 1, 4)), 4_000)
    if (delayMs > 0) await sleep(delayMs)
  }
}
