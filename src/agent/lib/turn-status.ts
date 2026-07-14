/**
 * Agent turn lifecycle (Component A1: background-survivable turns).
 *
 * A turn keeps running server-side even after the iPhone app is backgrounded —
 * the chat route no longer ties the turn to the client connection. These helpers
 * persist the running/terminal state so the client can re-sync on re-open, and
 * provide the cross-instance Stop signal: a cancel POST lands on a different
 * serverless instance than the running turn, so the running loop polls
 * `cancelRequested` each iteration rather than relying on an in-memory abort.
 *
 * Every call is fail-open: a turn-status glitch must never break the actual turn.
 */
import { prisma } from '@/lib/prisma'

export type TurnStatus = 'running' | 'done' | 'error' | 'canceled'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

/** Create a `running` turn row and return its id (null if persistence fails). */
export async function createTurn(
  conversationId: string,
  opts?: { clientMessageId?: string | null; executionMode?: 'inline' | 'worker' },
): Promise<string | null> {
  try {
    const row = await db().agentTurn.create({
      data: {
        conversationId,
        status: 'running',
        clientMessageId: opts?.clientMessageId ?? null,
        executionMode: opts?.executionMode ?? null,
      },
      select: { id: true },
    })
    return row.id as string
  } catch (err) {
    console.warn('[turn-status] createTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface TurnSnapshot {
  id: string
  conversationId: string
  status: TurnStatus
  clientMessageId: string | null
  userMessageId: string | null
  assistantMessageId: string | null
  lastSeq: number
  executionMode: string | null
  startedAt: Date
  updatedAt: Date | null
}

const TURN_SNAPSHOT_SELECT = {
  id: true,
  conversationId: true,
  status: true,
  clientMessageId: true,
  userMessageId: true,
  assistantMessageId: true,
  lastSeq: true,
  executionMode: true,
  startedAt: true,
  updatedAt: true,
} as const

/**
 * Roadmap 3.2 — idempotent find-or-create keyed by the CLIENT-generated
 * clientMessageId. The database uniqueness constraint (conversationId,
 * clientMessageId) is the real guarantee — an in-memory lock means nothing across
 * serverless instances. A retry (timeout, reconnect, watchdog fallback) returns
 * the EXISTING turn instead of creating another message/turn/execution.
 * The lookup is by key alone first so a fresh-conversation retry (client had no
 * conversationId yet) still finds the turn its first attempt created.
 */
export async function findOrCreateTurnByClientMessageId(
  conversationId: string,
  clientMessageId: string,
  executionMode: 'inline' | 'worker',
): Promise<{ turn: TurnSnapshot; created: boolean } | null> {
  try {
    const existing = await db().agentTurn.findFirst({
      where: { clientMessageId },
      orderBy: { startedAt: 'desc' },
      select: TURN_SNAPSHOT_SELECT,
    })
    if (existing) return { turn: existing as TurnSnapshot, created: false }
    try {
      const row = await db().agentTurn.create({
        data: { conversationId, status: 'running', clientMessageId, executionMode },
        select: TURN_SNAPSHOT_SELECT,
      })
      return { turn: row as TurnSnapshot, created: true }
    } catch (err) {
      // Unique-constraint race: a concurrent retry created it first — return that one.
      const raced = await db().agentTurn.findFirst({
        where: { clientMessageId },
        orderBy: { startedAt: 'desc' },
        select: TURN_SNAPSHOT_SELECT,
      })
      if (raced) return { turn: raced as TurnSnapshot, created: false }
      throw err
    }
  } catch (err) {
    console.warn('[turn-status] findOrCreateTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Latest turn carrying this idempotency key, if any (global — a fresh-chat
 *  retry has no conversationId yet). */
export async function findTurnByClientMessageId(clientMessageId: string): Promise<TurnSnapshot | null> {
  try {
    const row = await db().agentTurn.findFirst({
      where: { clientMessageId },
      orderBy: { startedAt: 'desc' },
      select: TURN_SNAPSHOT_SELECT,
    })
    return (row as TurnSnapshot) ?? null
  } catch (err) {
    console.warn('[turn-status] findTurnByClientMessageId failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Full lifecycle snapshot of one turn (roadmap 3.6). */
export async function getTurnSnapshot(turnId: string): Promise<TurnSnapshot | null> {
  try {
    const row = await db().agentTurn.findUnique({
      where: { id: turnId },
      select: TURN_SNAPSHOT_SELECT,
    })
    return (row as TurnSnapshot) ?? null
  } catch (err) {
    console.warn('[turn-status] getTurnSnapshot failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Link the persisted owner message to its turn — set once, never overwritten. */
export async function linkTurnUserMessage(turnId: string | null, messageId: string): Promise<void> {
  if (!turnId) return
  try {
    await db().agentTurn.updateMany({
      where: { id: turnId, userMessageId: null },
      data: { userMessageId: messageId },
    })
  } catch (err) {
    console.warn('[turn-status] linkTurnUserMessage failed:', err instanceof Error ? err.message : err)
  }
}

/** Link the persisted assistant reply to its turn (terminal reconciliation). */
export async function linkTurnAssistantMessage(turnId: string | null, messageId: string): Promise<void> {
  if (!turnId || !messageId) return
  try {
    await db().agentTurn.updateMany({
      where: { id: turnId },
      data: { assistantMessageId: messageId },
    })
  } catch (err) {
    console.warn('[turn-status] linkTurnAssistantMessage failed:', err instanceof Error ? err.message : err)
  }
}

/** Move a still-running turn to a terminal status. No-op if already terminal. */
export async function finalizeTurnIfRunning(
  turnId: string | null,
  status: Exclude<TurnStatus, 'running'>,
): Promise<void> {
  if (!turnId) return
  try {
    await db().agentTurn.updateMany({
      where: { id: turnId, status: 'running' },
      data: { status, finishedAt: new Date() },
    })
  } catch (err) {
    console.warn('[turn-status] finalizeTurnIfRunning failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Cancel every still-running turn of a conversation (idempotent, fail-open).
 * Used by the A2 enqueue route so a conversation can only ever have ONE live
 * turn: the client's first-event watchdog re-runs a "hung" send through the VPS
 * worker, but the direct serverless run is deliberately NOT tied to the client
 * connection — without this supersede the same message could execute twice in
 * parallel (owner bug 2026-07-12: research re-ran inside the same thread).
 */
export async function cancelRunningTurnsForConversation(conversationId: string): Promise<number> {
  try {
    const res = await db().agentTurn.updateMany({
      where: { conversationId, status: 'running' },
      data: { cancelRequested: true, status: 'canceled', finishedAt: new Date() },
    })
    return (res.count as number) ?? 0
  } catch (err) {
    console.warn('[turn-status] cancelRunningTurnsForConversation failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** Flip the cancel flag and mark the turn canceled (idempotent). */
export async function requestTurnCancel(turnId: string): Promise<boolean> {
  try {
    const res = await db().agentTurn.updateMany({
      where: { id: turnId },
      data: { cancelRequested: true, status: 'canceled', finishedAt: new Date() },
    })
    return res.count > 0
  } catch (err) {
    console.warn('[turn-status] requestTurnCancel failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** True if the owner asked to cancel this turn. Polled each loop iteration. */
export async function isTurnCancelRequested(turnId: string | null | undefined): Promise<boolean> {
  if (!turnId) return false
  try {
    const row = await db().agentTurn.findUnique({
      where: { id: turnId },
      select: { cancelRequested: true },
    })
    return row?.cancelRequested === true
  } catch (err) {
    console.warn('[turn-status] isTurnCancelRequested failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Authorization bridge for the A2 VPS-handoff path: the worker runs an owner web
 * turn by calling the chat route with the internal token, which normally may only
 * touch `telegram` conversations. It proves the turn was legitimately enqueued by
 * passing the turnId the enqueue route created — this confirms that row exists,
 * is still running, and belongs to the claimed conversation.
 */
export async function isRunningTurnForConversation(
  turnId: string | null | undefined,
  conversationId: string,
): Promise<boolean> {
  if (!turnId) return false
  try {
    const row = await db().agentTurn.findUnique({
      where: { id: turnId },
      select: { conversationId: true, status: true },
    })
    return row?.conversationId === conversationId && row?.status === 'running'
  } catch (err) {
    console.warn('[turn-status] isRunningTurnForConversation failed:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Current status of a specific turn (by id). Null if missing/unreadable. */
export async function getTurnStatus(turnId: string): Promise<TurnStatus | null> {
  try {
    const row = await db().agentTurn.findUnique({
      where: { id: turnId },
      select: { status: true },
    })
    return (row?.status as TurnStatus) ?? null
  } catch (err) {
    console.warn('[turn-status] getTurnStatus failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * A turn that has been 'running' longer than this is a ghost: Vercel froze the
 * disconnected function before its finally block could finalize the row (nothing
 * legitimate outlives the 25-min worker cap). Ghosts must self-heal — a stuck
 * 'running' row keeps the app's resume spinner alive forever AND stays eligible
 * for a stale worker-job re-run of the whole turn.
 */
const GHOST_RUNNING_MS = 30 * 60 * 1000

/** Latest turn for a conversation — drives the client's re-open polling.
 *  Returns the roadmap-3.6 snapshot: lastSeq distinguishes "stream quiet but
 *  alive" from "stale/ghost"; assistantMessageId lets the client fetch the exact
 *  final row. */
export async function getLatestTurn(
  conversationId: string,
): Promise<(TurnSnapshot & { id: string }) | null> {
  try {
    const row = await db().agentTurn.findFirst({
      where: { conversationId },
      orderBy: { startedAt: 'desc' },
      select: TURN_SNAPSHOT_SELECT,
    })
    if (!row) return null
    if (row.status === 'running' && Date.now() - new Date(row.startedAt).getTime() > GHOST_RUNNING_MS) {
      await finalizeTurnIfRunning(row.id as string, 'error')
      return { ...(row as TurnSnapshot), status: 'error' as TurnStatus }
    }
    return row as TurnSnapshot
  } catch (err) {
    console.warn('[turn-status] getLatestTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}
