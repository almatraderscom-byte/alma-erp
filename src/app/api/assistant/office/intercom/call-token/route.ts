/**
 * Office Live Intercom — Agora RTC call token minting.
 *   POST /api/assistant/office/intercom/call-token  { channel: string, renewal?: boolean }
 *     → { appId, channel, token, uid, expiresAt }
 *
 * Both the owner and any active staff member may mint a token (either side can
 * start or answer a 1:1 voice call). The client hook (useAgoraCall) receives the
 * appId back here, so it never needs the NEXT_PUBLIC_AGORA_APP_ID at runtime.
 *
 * Requires AGORA_APP_ID + AGORA_APP_CERTIFICATE on the server; without them the
 * feature returns 503 { error:'agora_unconfigured' } and the UI can hide the call
 * button. Canonical calls use a stable, participant-bound non-zero Agora uid;
 * legacy live-intercom channels retain uid=0 compatibility.
 */
import { type NextRequest } from 'next/server'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import {
  callIdFromAgoraChannel,
  OFFICE_CALL_TIMING,
  safeRecordOfficeCallEvent,
} from '@/agent/lib/office-call-observability'
import {
  authorizeCanonicalAgoraLeg,
  isCanonicalOfficeCallEnabled,
} from '@/agent/lib/office-call-domain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOKEN_TTL_SEC = OFFICE_CALL_TIMING.tokenTtlSec
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identifyOfficeCallRequest(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })

  const appId = process.env.AGORA_APP_ID?.trim()
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim()
  if (!appId || !appCertificate) {
    return Response.json({ error: 'agora_unconfigured' }, { status: 503 })
  }

  let body: { channel?: string; renewal?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const channel = body.channel?.trim()
  if (!channel) return Response.json({ error: 'channel_required' }, { status: 400 })

  const callId = callIdFromAgoraChannel(channel)
  if (channel.startsWith('itc_') && !channel.startsWith('itc_live_') && !callId) {
    return Response.json({ error: 'invalid_call_channel' }, { status: 400 })
  }
  let uid = 0
  if (callId) {
    const canonicalExists = isCanonicalOfficeCallEnabled()
      ? await prisma.officeCallSession.findUnique({ where: { id: callId }, select: { id: true } })
      : null
    if (canonicalExists) {
      const authorized = await authorizeCanonicalAgoraLeg({
        callId,
        businessId: id.businessId,
        userId: id.userId,
        channel,
      })
      if (!authorized.ok) {
        const status = authorized.error === 'call_ended' ? 409 : 403
        return Response.json({ error: authorized.error }, { status })
      }
      uid = authorized.uid
    } else {
      const participant = await prisma.officeIntercomBroadcast.findFirst({
        where: {
          id: callId,
          businessId: id.businessId,
          kind: 'call',
          OR: [{ senderUserId: id.userId }, { targetUserId: id.userId }],
        },
        select: { id: true },
      })
      if (!participant) return Response.json({ error: 'call_forbidden' }, { status: 403 })
    }
  }
  const now = Math.floor(Date.now() / 1000)
  const privilegeExpireTs = now + TOKEN_TTL_SEC

  let token: string
  try {
    token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channel,
      uid,
      RtcRole.PUBLISHER,
      TOKEN_TTL_SEC,
      privilegeExpireTs,
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown token error'
    console.error('[office/intercom/call-token] token build failed:', detail)
    return Response.json({ error: 'token_build_failed', detail }, { status: 500 })
  }

  if (callId) {
    await safeRecordOfficeCallEvent({
      callId,
      businessId: id.businessId,
      actorUserId: id.userId,
      source: 'server',
      event: body.renewal ? 'agora.token_renewed' : 'agora.token_minted',
      success: true,
      metadata: { ttlSec: TOKEN_TTL_SEC, uid },
    })
  }

  return Response.json({
    appId,
    channel,
    token,
    uid,
    expiresAt: new Date(privilegeExpireTs * 1000).toISOString(),
  })
}
