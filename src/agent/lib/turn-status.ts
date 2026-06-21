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
    return row ?? null
  } catch (err) {
    console.warn('[turn-status] getLatestTurn failed:', err instanceof Error ? err.message : err)
    return null
  }
}
