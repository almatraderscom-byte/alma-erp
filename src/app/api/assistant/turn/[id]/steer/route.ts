import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { Prisma } from '@prisma/client'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isPotentialYouTubeComputerUseMutation } from '@/agent/lib/live-browser/intent'
import {
  directYouTubeLaneIdForConversation,
  lockDirectYouTubeLaneAuthority,
} from '@/agent/lib/live-browser/turn-lane'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

interface SteeringFileRef {
  bucket?: unknown
  path?: unknown
  mediaType?: unknown
}
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const turnId = params.id
  const clientMessageId = String(body.clientMessageId ?? '').trim()
  const message = String(body.message ?? '').trim()
  const files = Array.isArray(body.files) ? body.files as SteeringFileRef[] : []
  if (!clientMessageId || (!message && files.length === 0)) {
    return Response.json({ error: 'clientMessageId_and_content_required' }, { status: 400 })
  }
  if (message.length > 20_000) return Response.json({ error: 'message_too_long' }, { status: 413 })
  const requiresFreshDirectTurn = isPotentialYouTubeComputerUseMutation(message)

  const turn = await prisma.agentTurn.findUnique({
    where: { id: turnId },
    select: { id: true, conversationId: true, status: true },
  })
  if (!turn) return Response.json({ error: 'turn_not_found' }, { status: 404 })
  if (turn.status !== 'running') {
    return Response.json({ error: 'turn_not_running', status: turn.status }, { status: 409 })
  }

  const content: Array<Record<string, string>> = []
  if (message) content.push({ type: 'text', text: message })
  for (const file of files) {
    const bucket = String(file.bucket ?? '').trim()
    const path = String(file.path ?? '').trim()
    const mediaType = String(file.mediaType ?? 'application/octet-stream').trim()
    if (bucket && path) content.push({ type: 'file_ref', bucket, path, mediaType })
  }

  const existing = await prisma.agentMessage.findUnique({
    where: { clientRequestId: clientMessageId },
    select: { id: true, conversationId: true },
  })
  if (existing) {
    if (existing.conversationId !== turn.conversationId) {
      return Response.json({ error: 'client_message_conflict' }, { status: 409 })
    }
    return Response.json({ success: true, messageId: existing.id, duplicate: true, turnId })
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      // Linearize steering acceptance against direct-browser command enqueue.
      // Both paths lock the deterministic lane row. If this transaction wins,
      // the lane is abandoned before the steering message becomes accepted,
      // so an in-flight old handler cannot queue a later browser effect.
      await lockDirectYouTubeLaneAuthority(tx, turn.conversationId)
      const lanes = await tx.$queryRaw<Array<{
        id: string
        status: string
        currentStep: string | null
        version: number
        artifacts: unknown
      }>>(Prisma.sql`
        SELECT "id", "status", "current_step" AS "currentStep", "version", "artifacts"
        FROM "agent_conversation_focuses"
        WHERE "id" = ${directYouTubeLaneIdForConversation(turn.conversationId)}
        FOR UPDATE
      `)
      const lane = lanes[0]
      const laneArtifacts = lane?.artifacts && typeof lane.artifacts === 'object' && !Array.isArray(lane.artifacts)
        ? lane.artifacts as Record<string, unknown>
        : {}
      const laneToken = typeof laneArtifacts.laneToken === 'string'
        ? laneArtifacts.laneToken.trim()
        : ''
      const laneBelongsToTurn = laneToken === turnId
      const targetOwnsOpenDirectLane = Boolean(
        lane
        && laneBelongsToTurn
        && (lane.status === 'active' || lane.status === 'awaiting_owner'),
      )
      if (lane && targetOwnsOpenDirectLane) {
        const revokedAt = new Date()
        const revoked = await tx.agentConversationFocus.updateMany({
          where: { id: lane.id, version: lane.version },
          data: {
            status: 'abandoned',
            currentStep: 'steered_by_owner',
            blocker: 'owner_steering_revoked_lane',
            leaseUntil: revokedAt,
            completedAt: revokedAt,
            version: lane.version + 1,
          },
        })
        if (revoked.count !== 1) throw new Error('direct_browser_lane_revoke_conflict')
        await tx.agentFocusEvent.create({
          data: {
            focusId: lane.id,
            conversationId: turn.conversationId,
            type: 'abandoned',
            fromStatus: lane.status,
            toStatus: 'abandoned',
            version: lane.version + 1,
            cause: 'owner_steering',
            detail: { fromStep: lane.currentStep, targetTurnId: turnId },
          },
        })
      }

      const currentTurn = await tx.agentTurn.findUnique({
        where: { id: turnId },
        select: { status: true },
      })
      if (currentTurn?.status !== 'running') throw new Error('turn_not_running_during_steer')

      // A direct browser request needs a new immutable AgentTurn binding; and a
      // steering message aimed at an existing direct lane must not keep running
      // under that lane's now-revoked token. Return 409 without persisting—the
      // client outbox already retries 409s as a normal turn after this stream.
      if (requiresFreshDirectTurn || targetOwnsOpenDirectLane) return null

      const created = await tx.agentMessage.create({
        data: {
          conversationId: turn.conversationId,
          clientRequestId: clientMessageId,
          role: 'user',
          content,
          usage: {
            steering: {
              targetTurnId: turnId,
              status: 'queued',
              queuedAt: new Date().toISOString(),
            },
          },
        },
        select: { id: true },
      })
      await tx.agentConversation.update({
        where: { id: turn.conversationId },
        data: { updatedAt: new Date() },
      })
      return created
    })
    if (!row) {
      return Response.json({ error: 'direct_browser_requires_fresh_turn', turnId }, { status: 409 })
    }
    return Response.json({ success: true, messageId: row.id, duplicate: false, turnId })
  } catch (err) {
    // A retry can race the first request between findUnique and create. The
    // unique clientRequestId is authoritative; return that same logical send.
    const raced = await prisma.agentMessage.findUnique({
      where: { clientRequestId: clientMessageId }, select: { id: true, conversationId: true },
    })
    if (raced?.conversationId === turn.conversationId) {
      return Response.json({ success: true, messageId: raced.id, duplicate: true, turnId })
    }
    console.warn('[turn-steer] persist failed:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'persist_failed' }, { status: 500 })
  }
}

/**
 * Was a queued message ever actually taken up?
 *
 * The client needs this after a RELOAD. `/steer` returning 2xx means the row is
 * persisted, not that any model loop read it — and the chat route's error path
 * finalizes without the last-moment claim, so a turn that fails right after a
 * message is accepted leaves that instruction unexecuted (Codex). Treating
 * acceptance as delivery made those permanently invisible: excluded from
 * replay, then dropped on the next load.
 *
 * Read-only, owner-gated, keyed by the client's own id.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const clientMessageId = String(req.nextUrl.searchParams.get('clientMessageId') ?? '').trim()
  if (!clientMessageId) return Response.json({ error: 'clientMessageId_required' }, { status: 400 })

  const row = await prisma.agentMessage.findUnique({
    where: { clientRequestId: clientMessageId },
    select: { id: true, usage: true },
  })
  if (!row) return Response.json({ status: 'unknown', turnId: params.id })

  const usage = row.usage && typeof row.usage === 'object' ? row.usage as Record<string, unknown> : {}
  const steering = usage.steering && typeof usage.steering === 'object'
    ? usage.steering as Record<string, unknown>
    : {}
  return Response.json({
    status: steering.status === 'consumed' ? 'consumed' : 'queued',
    messageId: row.id,
    turnId: params.id,
  })
}
