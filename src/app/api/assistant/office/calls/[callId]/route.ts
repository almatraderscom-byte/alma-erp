import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import {
  getCanonicalOfficeCallForParticipant,
  transitionCanonicalOfficeCall,
  type OfficeCallStateValue,
} from '@/agent/lib/office-call-domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { callId: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })
  const callId = params.callId?.trim()
  if (!callId) return Response.json({ error: 'call_required' }, { status: 400 })

  const lookup = {
    callId,
    businessId: identity.businessId,
    userId: identity.userId,
  }
  let session = await getCanonicalOfficeCallForParticipant(lookup)
  if (!session) return Response.json({ error: 'not_found' }, { status: 404 })
  const now = new Date()
  if (session.state !== 'ENDED' && (now >= session.ringExpiresAt || now >= session.maxEndsAt)) {
    await transitionCanonicalOfficeCall({
      callId,
      businessId: identity.businessId,
      actorRole: 'server',
      target: session.state as OfficeCallStateValue,
      now,
    })
    session = await getCanonicalOfficeCallForParticipant(lookup)
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 })
  }
  const ownLeg = session.legs.find((leg) => leg.participantUserId === identity.userId)
  return Response.json({
    call: {
      id: session.id,
      state: session.state,
      version: session.version,
      terminalReason: session.terminalReason,
      direction: session.callerUserId === identity.userId ? 'outgoing' : 'incoming',
      channel: session.agoraChannel,
      uid: ownLeg?.agoraUid ?? null,
      ringExpiresAt: session.ringExpiresAt,
      maxEndsAt: session.maxEndsAt,
      answeredAt: session.answeredAt,
      connectedAt: session.connectedAt,
      endedAt: session.endedAt,
      updatedAt: session.updatedAt,
    },
  })
}
