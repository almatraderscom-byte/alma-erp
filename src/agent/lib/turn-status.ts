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
 * Observability/cancel helpers are fail-open. Exactly-once claim helpers are
 * deliberately fail-closed: uncertainty must never execute an owner task twice.
 */
import { prisma } from '@/lib/prisma'

export type TurnStatus = 'running' | 'done' | 'error' | 'canceled'
export type TurnClaim = { turnId: string | null; claimed: boolean; status: TurnStatus | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

/** Create a `running` turn row and return its id (null if persistence fails). */
export async function createTurn(conversationId: string): Promise<string | null> {
  try {
    const row = await db().agentTurn.create({
      data: { conversationId, status: 'running' },
      select: { id: true },
    })
    return row.id as string
  } catch (err) {
    console.warn('[turn-status] createTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Claim one execution for a browser-generated logical request id. Direct Vercel
 * execution and the 15s VPS fallback race on the same unique key; only the winner
 * may execute. The loser receives the winner's turn id and observes its result.
 */
export async function claimTurnForRequest(
  conversationId: string,
  requestId: string,
): Promise<TurnClaim> {
  try {
    const row = await db().agentTurn.create({
      data: { conversationId, requestId, status: 'running' },
      select: { id: true, status: true },
    })
    return { turnId: row.id as string, claimed: true, status: row.status as TurnStatus }
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2002') {
      console.warn('[turn-status] claimTurnForRequest failed:', err instanceof Error ? err.message : err)
      return { turnId: null, claimed: false, status: null }
    }
    try {
      const row = await db().agentTurn.findUnique({
        where: { requestId },
        select: { id: true, conversationId: true, status: true },
      })
      if (!row || row.conversationId !== conversationId) return { turnId: null, claimed: false, status: null }
      return { turnId: row.id as string, claimed: false, status: row.status as TurnStatus }
    } catch (lookupErr) {
      console.warn('[turn-status] request claim lookup failed:', lookupErr instanceof Error ? lookupErr.message : lookupErr)
      return { turnId: null, claimed: false, status: null }
    }
  }
}

/**
 * Atomically consume a persisted `continuationNeeded` flag and create its sole
 * successor turn. No owner/user message is involved. Replays and double clicks
 * lose the claim and cannot execute the continuation again.
 */
export async function claimContinuationTurn(
  conversationId: string,
  previousTurnId: string,
): Promise<TurnClaim> {
  try {
    return await db().$transaction(async (tx: any) => {
      const claimed = await tx.agentTurn.updateMany({
        where: {
          id: previousTurnId,
          conversationId,
          status: 'done',
          continuationNeeded: true,
          continuationClaimedAt: null,
        },
        data: { continuationClaimedAt: new Date() },
      })
      if (claimed.count !== 1) {
        const existing = await tx.agentTurn.findUnique({
          where: { continuationOfTurnId: previousTurnId },
          select: { id: true, status: true },
        })
        return {
          turnId: (existing?.id as string | undefined) ?? null,
          claimed: false,
          status: (existing?.status as TurnStatus | undefined) ?? null,
        }
      }
      const row = await tx.agentTurn.create({
        data: { conversationId, continuationOfTurnId: previousTurnId, status: 'running' },
        select: { id: true, status: true },
      })
      return { turnId: row.id as string, claimed: true, status: row.status as TurnStatus }
    })
  } catch (err) {
    console.warn('[turn-status] claimContinuationTurn failed:', err instanceof Error ? err.message : err)
    return { turnId: null, claimed: false, status: null }
  }
}

/** Move a still-running turn to a terminal status. No-op if already terminal. */
export async function finalizeTurnIfRunning(
  turnId: string | null,
  status: Exclude<TurnStatus, 'running'>,
  options: { continuationNeeded?: boolean } = {},
): Promise<void> {
  if (!turnId) return
  try {
    await db().agentTurn.updateMany({
      where: { id: turnId, status: 'running' },
      data: {
        status,
        finishedAt: new Date(),
        continuationNeeded: status === 'done' && options.continuationNeeded === true,
      },
    })
  } catch (err) {
    console.warn('[turn-status] finalizeTurnIfRunning failed:', err instanceof Error ? err.message : err)
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

/** Latest turn for a conversation — drives the client's re-open polling. */
export async function getLatestTurn(
  conversationId: string,
): Promise<{ id: string; status: TurnStatus; startedAt: Date } | null> {
  try {
    const row = await db().agentTurn.findFirst({
      where: { conversationId },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, startedAt: true },
    })
    if (!row) return null
    if (row.status === 'running' && Date.now() - new Date(row.startedAt).getTime() > GHOST_RUNNING_MS) {
      await finalizeTurnIfRunning(row.id as string, 'error')
      return { ...row, status: 'error' as TurnStatus }
    }
    return row
  } catch (err) {
    console.warn('[turn-status] getLatestTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}
