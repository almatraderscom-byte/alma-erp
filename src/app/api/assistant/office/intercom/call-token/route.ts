/**
 * Office Live Intercom — Agora RTC call token minting.
 *   POST /api/assistant/office/intercom/call-token  { channel: string }
 *     → { appId, channel, token, uid }
 *
 * Both the owner and any active staff member may mint a token (either side can
 * start or answer a 1:1 voice call). The client hook (useAgoraCall) receives the
 * appId back here, so it never needs the NEXT_PUBLIC_AGORA_APP_ID at runtime.
 *
 * Requires AGORA_APP_ID + AGORA_APP_CERTIFICATE on the server; without them the
 * feature returns 503 { error:'agora_unconfigured' } and the UI can hide the call
 * button. uid = 0 lets Agora assign a uid at join time (simplest 1:1 case).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOKEN_TTL_SEC = 3600 // 1 hour — a call session is short; the client re-mints if needed.

type Caller =
  | { ok: true }
  | { ok: false; error: string; code: number }

/** Owner OR active staff may mint a call token; anyone else is 401. */
async function identify(req: NextRequest): Promise<Caller> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { ok: false, error: 'unauthorized', code: 401 }
  if (isSystemOwner(token)) return { ok: true }
  const staff = await resolveSessionStaff(token.sub)
  if (staff) return { ok: true }
  return { ok: false, error: 'unauthorized', code: 401 }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identify(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })

  const appId = process.env.AGORA_APP_ID?.trim()
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim()
  if (!appId || !appCertificate) {
    return Response.json({ error: 'agora_unconfigured' }, { status: 503 })
  }

  let body: { channel?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const channel = body.channel?.trim()
  if (!channel) return Response.json({ error: 'channel_required' }, { status: 400 })

  // uid = 0 → let Agora assign a uid at join time (fine for a 1:1 intercom call).
  const uid = 0
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

  return Response.json({ appId, channel, token, uid })
}
