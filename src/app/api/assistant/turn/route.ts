import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  cancelRunningTurnsForConversation,
  createTurn,
  findOrCreateTurnByClientMessageId,
  findTurnByClientMessageId,
  type TurnSnapshot,
} from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'

export const runtime = 'nodejs'

/**
 * VPS handoff for genuinely long turns (Component A2) + the Phase-3 idempotent
 * turn command (roadmap 3.2/3.3).
 *
 * This route ENQUEUES the turn onto the `long-agent-task` BullMQ queue the VPS
 * worker drains; the worker runs it and republishes events to Redis + the
 * `agent_turn_events` log, tailed via `/api/assistant/turn/:id/stream`. This
 * route never executes a turn.
 *
 * Phase 3 semantics with a `clientMessageId`:
 *  - the same key NEVER creates a second message/turn/execution — a retry
 *    observes the existing turn (`duplicate: true`);
 *  - a duplicate whose direct (inline) run is HEALTHY (has produced events, or is
 *    young) is returned as-is — the client re-attaches to its stream;
 *  - a duplicate whose direct run is DEAD (no events after a grace window) is
 *    re-dispatched to the worker under the SAME turnId — execution environments
 *    hand off the turn, the client never re-sends the prompt;
 *  - a fresh conversation is created here when the client has none yet.
 * Legacy bodies (no clientMessageId) keep the old cancel-then-recreate behavior.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!isTurnHandoffConfigured()) {
    return Response.json(
      { error: 'handoff_unavailable', message: 'VPS worker queue (REDIS_URL) not configured.' },
      { status: 503 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return Response.json({ error: 'message_required' }, { status: 400 })

  const clientMessageId =
    typeof body.clientMessageId === 'string' && body.clientMessageId.trim()
      ? body.clientMessageId.trim().slice(0, 64)
      : null

  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null

  const turnSummary = (t: TurnSnapshot, extra?: Record<string, unknown>) =>
    Response.json({
      turnId: t.id,
      conversationId: t.conversationId,
      status: t.status,
      lastSeq: t.lastSeq,
      userMessageId: t.userMessageId,
      assistantMessageId: t.assistantMessageId,
      ...extra,
    })

  // ── Idempotency gate (before any create) ────────────────────────────────
  if (clientMessageId) {
    const existing = await findTurnByClientMessageId(clientMessageId)
    if (existing) {
      // A direct run that never produced an event within the grace window is
      // presumed dead (cold-start kill / crash). Re-dispatch on the worker: the
      // stale turn is cancelled (its loop polls cancelRequested, so a secretly
      // alive run stops) and the idempotency key MOVES to the replacement turn in
      // one transaction — later retries with the same key resolve to the live
      // replacement, and the two executions can never overlap on one turn row.
      const ageMs = Date.now() - new Date(existing.startedAt).getTime()
      const stale = existing.status === 'running' && existing.lastSeq < 0 && ageMs > 15_000
      if (!stale) return turnSummary(existing, { duplicate: true })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replacement = await (prisma as any).$transaction(async (tx: any) => {
        await tx.agentTurn.update({
          where: { id: existing.id },
          data: { clientMessageId: null, cancelRequested: true, status: 'canceled', finishedAt: new Date() },
        })
        return tx.agentTurn.create({
          data: {
            conversationId: existing.conversationId,
            status: 'running',
            clientMessageId,
            executionMode: 'worker',
            userMessageId: existing.userMessageId,
          },
        })
      }).catch((err: unknown) => {
        console.warn('[assistant/turn] stale redispatch failed:', err instanceof Error ? err.message : err)
        return null
      })
      if (!replacement) return turnSummary(existing, { duplicate: true })

      const jobData = buildTurnJobData(replacement.id, existing.conversationId, {
        ...body,
        conversationId: existing.conversationId,
      } as Parameters<typeof buildTurnJobData>[2])
      if (!jobData) return Response.json({ error: 'message_required' }, { status: 400 })
      const jobId = await enqueueTurnJob(jobData)
      if (!jobId) {
        return Response.json({ error: 'enqueue_failed', message: 'Could not enqueue turn on the worker queue.' }, { status: 502 })
      }
      return turnSummary(replacement as TurnSnapshot, { duplicate: true, redispatched: true, jobId })
    }
  }

  // ── Conversation: accept existing or create fresh (roadmap 3.2) ─────────
  if (conversationId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = await (prisma as any).agentConversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    })
    if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv: { id: string } = await (prisma as any).agentConversation.create({
      data: {
        title: message.slice(0, 60) || null,
        source: 'web',
        projectId: typeof body.projectId === 'string' ? body.projectId : null,
      },
      select: { id: true },
    })
    conversationId = conv.id
  }

  // ONE live turn per conversation: this enqueue is the client's fallback after
  // it gave up on a direct serverless run — but that run is deliberately not tied
  // to the client connection and may still be executing. Cancel it (the turn loop
  // polls cancelRequested) before starting the worker run, so the same message
  // can never execute twice in parallel.
  const superseded = await cancelRunningTurnsForConversation(conversationId)
  if (superseded > 0) {
    console.warn(`[assistant/turn] superseded ${superseded} running turn(s) on conversation ${conversationId}`)
  }

  let turnId: string | null
  if (clientMessageId) {
    const r = await findOrCreateTurnByClientMessageId(conversationId, clientMessageId, 'worker')
    if (r && !r.created) return turnSummary(r.turn, { duplicate: true })
    turnId = r?.turn.id ?? null
  } else {
    turnId = await createTurn(conversationId, { executionMode: 'worker' })
  }

  const jobData = buildTurnJobData(turnId, conversationId, body as Parameters<typeof buildTurnJobData>[2])
  if (!jobData) return Response.json({ error: 'message_required' }, { status: 400 })

  const jobId = await enqueueTurnJob(jobData)
  if (!jobId) {
    return Response.json({ error: 'enqueue_failed', message: 'Could not enqueue turn on the worker queue.' }, { status: 502 })
  }

  return Response.json({ turnId, conversationId, jobId, status: 'running', lastSeq: -1 })
}
