import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { claimTurnForRequest, finalizeTurnIfRunning } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'

export const runtime = 'nodejs'

/**
 * VPS handoff for genuinely long turns (Component A2).
 *
 * Instead of running the turn on this serverless function (capped at 300s), this
 * route ENQUEUES it onto the `long-agent-task` BullMQ queue the VPS worker drains.
 * The worker runs the turn and republishes its events to Redis + the
 * `agent_turn_events` log; the client then tails them via
 * `/api/assistant/turn/:id/stream`. This route never executes a turn.
 *
 * The client uses this as a fallback: if the direct `/api/assistant/chat` stream
 * produces no event within ~15s, it cancels that turn and re-runs it here.
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

  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  if (!conversationId) return Response.json({ error: 'conversation_required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conv = await (prisma as any).agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  })
  if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })

  const clientRequestId = typeof body.clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId)
    ? body.clientRequestId
    : null
  if (!clientRequestId) return Response.json({ error: 'client_request_id_required' }, { status: 400 })

  // Direct Vercel and VPS fallback race on one durable request id. If direct
  // already owns it, observe that turn instead of canceling/re-running the work.
  const claim = await claimTurnForRequest(conversationId, clientRequestId)
  if (!claim.claimed) {
    return Response.json({
      turnId: claim.turnId,
      conversationId,
      jobId: null,
      alreadyRunning: claim.status === 'running',
      status: claim.status,
    })
  }

  const turnId = claim.turnId
  const jobData = buildTurnJobData(turnId, conversationId, body as Parameters<typeof buildTurnJobData>[2])
  if (!jobData) {
    await finalizeTurnIfRunning(turnId, 'error')
    return Response.json({ error: 'message_required' }, { status: 400 })
  }

  const jobId = await enqueueTurnJob(jobData)
  if (!jobId) {
    await finalizeTurnIfRunning(turnId, 'error')
    return Response.json({ error: 'enqueue_failed', message: 'Could not enqueue turn on the worker queue.' }, { status: 502 })
  }

  return Response.json({ turnId, conversationId, jobId })
}
