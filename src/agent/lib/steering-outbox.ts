/**
 * The outbox for messages Boss types WHILE a turn is running.
 *
 * Owner report 2026-08-03: *"message ta jotokkhon porjonto agent er kache na
 * jay, seta jeno UI te visible thake, hariye na jay"* — and the old path could
 * lose it three different ways:
 *
 *  1. the running turn finished between his keystroke and the POST, so
 *     `/turn/:id/steer` answered `409 turn_not_running`, and the client
 *     DELETED the optimistic bubble and showed a toast. The message was gone
 *     from the thread, and from the composer too if he had started typing again.
 *  2. any network blip did the same thing.
 *  3. a reload before delivery lost anything that had not reached the server.
 *
 * So an undelivered message now lives here — in localStorage, survives a
 * reload — until the running turn actually claims it (`steering_delivered`) or
 * it is re-sent as an ordinary new turn.
 *
 * Pure module: no React, no fetch. The storage object is injected so this is
 * testable without a DOM, and every read is defensive — a corrupt entry must
 * never take the composer down with it.
 */

export interface SteeringOutboxEntry {
  /** Also the server's dedupe key: re-POSTing the same id can never double-send. */
  clientMessageId: string
  conversationId: string
  /** The turn this was aimed at. Once that turn is over it is sent as a new turn. */
  turnId: string
  text: string
  files: Array<{ bucket: string; path: string; mediaType: string }>
  queuedAt: string
  attempts: number
  /**
   * The server has this row (the POST returned 2xx). It matters on RELOAD: a
   * client-side turn id only exists for a live stream, so after a refresh every
   * entry looks "stranded" and would be re-sent as a new turn — running an
   * instruction the running turn may already have consumed (Codex round 3).
   * An accepted entry is durable server-side and is never replayed.
   */
  accepted?: boolean
  /** Last failure, kept for the retry chip's title — never shown as the reason to drop it. */
  lastError?: string
}

export const OUTBOX_STORAGE_KEY = 'alma:agent:steering-outbox:v1'
/** Beyond this an entry is stale enough that re-sending it would confuse more than help. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface OutboxStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The browser's localStorage, or null on the server / when it is unavailable. */
export function defaultOutboxStorage(): OutboxStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    // Safari private mode throws on access, not on use.
    return null
  }
}

function isEntry(value: unknown): value is SteeringOutboxEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.clientMessageId === 'string' && e.clientMessageId.length > 0
    && typeof e.conversationId === 'string'
    && typeof e.turnId === 'string'
    && typeof e.text === 'string'
    && Array.isArray(e.files)
    && typeof e.queuedAt === 'string'
    && typeof e.attempts === 'number'
}

export function loadOutbox(storage: OutboxStorage | null, now = Date.now()): SteeringOutboxEntry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(OUTBOX_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).filter((e) => {
      const at = Date.parse(e.queuedAt)
      return !Number.isFinite(at) || now - at < OUTBOX_MAX_AGE_MS
    })
  } catch {
    return []
  }
}

export function saveOutbox(storage: OutboxStorage | null, entries: SteeringOutboxEntry[]): void {
  if (!storage) return
  try {
    storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota or private mode — the in-memory copy still drives the UI this session.
  }
}

/** Add, or replace an entry with the same id (a retry must never duplicate a row). */
export function addEntry(
  entries: SteeringOutboxEntry[],
  entry: SteeringOutboxEntry,
): SteeringOutboxEntry[] {
  return [...entries.filter((e) => e.clientMessageId !== entry.clientMessageId), entry]
}

export function removeEntries(
  entries: SteeringOutboxEntry[],
  clientMessageIds: readonly string[],
): SteeringOutboxEntry[] {
  const drop = new Set(clientMessageIds)
  return entries.filter((e) => !drop.has(e.clientMessageId))
}

export function markAttempt(
  entries: SteeringOutboxEntry[],
  clientMessageId: string,
  error?: string,
): SteeringOutboxEntry[] {
  return entries.map((e) =>
    e.clientMessageId === clientMessageId
      ? { ...e, attempts: e.attempts + 1, ...(error ? { lastError: error } : {}) }
      : e)
}

/**
 * Entries whose target turn is no longer the running one — they cannot be
 * steered into anything, so they are re-sent as an ordinary new turn instead of
 * being dropped. This is the 409 case that used to delete the bubble.
 */
export function entriesToResend(
  entries: SteeringOutboxEntry[],
  activeTurnId: string | null,
  conversationId: string | null,
): SteeringOutboxEntry[] {
  if (!conversationId) return []
  return entries.filter((e) =>
    e.conversationId === conversationId
    && e.turnId !== activeTurnId
    // Already on the server: replaying it could run the same instruction twice.
    && !e.accepted)
}

/**
 * What survives a reload.
 *
 * Everything does. Dropping accepted entries was the first attempt and it was
 * wrong in the other direction (Codex): `/steer` returning 2xx means the row is
 * PERSISTED, not that any model loop read it, and the chat route's error path
 * finalizes without the last-moment claim — so a turn that fails right after a
 * message is accepted leaves that instruction unexecuted and invisible.
 *
 * Accepted entries are therefore kept and RECONCILED against the server (see
 * `/turn/:id/steer` GET): `consumed` drops them, `queued` clears the accepted
 * flag so the normal resend path can run them once the turn is over. Neither
 * blind replay nor blind deletion is safe on its own.
 */
export function rehydrate(entries: SteeringOutboxEntry[]): SteeringOutboxEntry[] {
  return entries
}

/** Apply a server verdict for one entry. `consumed` → drop, `queued` → replayable. */
export function applyServerStatus(
  entries: SteeringOutboxEntry[],
  clientMessageId: string,
  status: 'consumed' | 'queued' | 'unknown',
): SteeringOutboxEntry[] {
  if (status === 'consumed') return removeEntries(entries, [clientMessageId])
  return entries.map((e) =>
    e.clientMessageId === clientMessageId ? { ...e, accepted: false } : e)
}

/** Exponential-ish backoff, capped — a retry loop must not become a hot loop. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts))
}
