/**
 * End a live office call — POST /api/assistant/office/intercom/end
 *   { broadcastId: string, reason: 'cancelled'|'declined'|'missed'|'completed' }
 *
 * Either participant (caller or callee) may end. First writer wins; a "cancel"
 * wake push then stops the other side's ring instantly (WhatsApp-style), and the
 * call row is left as the missed-/completed-call history the feed renders.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import { endCall, type CallEndReason } from '@/agent/lib/office-intercom'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const REASONS: CallEndReason[] = ['cancelled', 'declined', 'missed', 'completed', 'failed']

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })

  let body: { broadcastId?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const broadcastId = body.broadcastId?.trim()
  if (!broadcastId) return Response.json({ error: 'broadcast_required' }, { status: 400 })
  const reason = (REASONS.includes(body.reason as CallEndReason) ? body.reason : 'completed') as CallEndReason

  const res = await endCall({
    broadcastId,
    businessId: identity.businessId,
    reason,
    actorUserId: identity.userId,
  })
  const status = res.ok ? 200 : res.error === 'forbidden' ? 403 : res.error === 'not_found' ? 404 : 409
  return Response.json(res, { status })
}
