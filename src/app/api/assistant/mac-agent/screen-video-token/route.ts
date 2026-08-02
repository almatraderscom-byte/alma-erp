/**
 * L9-B — Agora tokens for the Mac-screen VIDEO channel.
 *
 * Two callers, one channel per device (`mac-screen-<deviceId>`):
 *   - the DAEMON (its bearer token) → PUBLISHER token; its spawned
 *     ScreenBroadcaster pushes the ScreenCaptureKit feed here.
 *   - the OWNER (session cookie) → SUBSCRIBER token; the iOS dock (and later
 *     the web console) renders the live video.
 *
 * The channel is derived server-side from the AUTHENTICATED identity — a
 * caller can never name someone else's channel. Publisher uid is fixed (1),
 * viewers get 1000+ so multiple owner devices can watch at once.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { authenticateDevice, listDevices } from '@/agent/lib/mac-agent/bus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOKEN_TTL_SEC = 360 // streams are capped at 300s — no long-lived tokens

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const appId = process.env.AGORA_APP_ID?.trim()
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim()
  if (!appId || !appCertificate) {
    return Response.json({ error: 'agora_not_configured' }, { status: 503 })
  }

  const now = Math.floor(Date.now() / 1000)
  const expire = now + TOKEN_TTL_SEC

  // Daemon → publisher for ITS OWN device channel.
  const auth = req.headers.get('authorization') ?? ''
  if (auth.startsWith('Bearer ')) {
    const device = await authenticateDevice(auth.slice(7).trim())
    if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const channel = `mac-screen-${device.id}`
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId, appCertificate, channel, 1, RtcRole.PUBLISHER, TOKEN_TTL_SEC, expire,
    )
    return Response.json({ appId, channel, uid: 1, token, expiresAt: expire })
  }

  // Owner → subscriber for a device they own.
  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { deviceId?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const devices = await listDevices()
  const device = body.deviceId
    ? devices.find((d) => d.id === body.deviceId)
    : devices.find((d) => d.online && d.pairedAt)
  if (!device) return Response.json({ error: 'no_device' }, { status: 404 })

  const channel = `mac-screen-${device.id}`
  const uid = 1000 + Math.floor(Math.random() * 100000)
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId, appCertificate, channel, uid, RtcRole.SUBSCRIBER, TOKEN_TTL_SEC, expire,
  )
  return Response.json({ appId, channel, uid, token, expiresAt: expire })
}
