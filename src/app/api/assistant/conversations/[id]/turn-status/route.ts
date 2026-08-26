import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getLatestTurn } from '@/agent/lib/turn-status'
import { proseProtocolFromVersions } from '@/agent/lib/presentation/prose-lifecycle'

export const runtime = 'nodejs'

/**
 * Latest turn status for a conversation. The client polls this on app re-open: a
 * turn keeps running server-side after backgrounding, so the app waits for the
 * status to leave `running`, then re-fetches messages to render the reply.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  let turn = await getLatestTurn(id)
  if (!turn) return Response.json({ status: 'idle', turnId: null })
  // Reopen-time stall revive (owner 2026-08-26): this poll is the moment the
  // server learns someone is looking at a possibly-dead turn. The updatedAt
  // pre-gate keeps the healthy-turn poll path at zero extra queries; the
  // revive module re-verifies silence against the durable event log itself.
  if (turn.status === 'running') {
    const { reviveStalledInlineTurn, reviveSilentMs } = await import('@/agent/lib/turn-revive')
    const lastTouch = turn.updatedAt ? new Date(turn.updatedAt).getTime() : new Date(turn.startedAt).getTime()
    if (Date.now() - lastTouch >= reviveSilentMs()) {
      const revived = await reviveStalledInlineTurn({ turnId: turn.id, conversationId: id })
      if (revived.revived) turn = (await getLatestTurn(id)) ?? turn
    }
  }
  // Roadmap 3.6 — lastSeq lets the client tell "stream quiet but alive" from
  // stale/ghost; assistantMessageId lets it fetch the exact final row.
  return Response.json({
    status: turn.status,
    turnId: turn.id,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    lastSeq: turn.lastSeq,
    assistantMessageId: turn.assistantMessageId,
    executionMode: turn.executionMode,
    // iOS recovery: when a long turn's terminal is discovered by POLLING (its SSE
    // and durable tail both gone), this is the only way the client can still see
    // that the turn ended continuation-eligible. claimContinuationTurn keeps the
    // actual claim exactly-once regardless of how many clients read this.
    continuationNeeded: turn.continuationNeeded === true,
    // Prose lifecycle v2: which family this turn streamed (reducer selection
    // on recovery must come from the server, never from event shapes).
    agentProseProtocol: proseProtocolFromVersions(turn.versions),
  })
}
