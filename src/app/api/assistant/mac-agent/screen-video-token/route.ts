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
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { getJwt } from '@/lib/api-guards'
import { isSystemOwner } from '@/lib/roles'
import { authenticateDevice, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'
import { isKnownViewUid, registerViewUid } from '@/agent/lib/mac-agent/remote-control'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TOKEN_TTL_SEC = 360 // streams are capped at 300s — no long-lived tokens
const DEVICE_OFFLINE_MS = 90_000

async function findOwnedViewerDevice(ownerUserId: string, deviceId?: string) {
  const select = { id: true, pairedAt: true } as const
  if (deviceId) {
    return prisma.macAgentDevice.findFirst({
      where: { id: deviceId, ownerUserId, revoked: false },
      select,
    })
  }
  return prisma.macAgentDevice.findFirst({
    where: {
      ownerUserId,
      revoked: false,
      pairedAt: { not: null },
      lastSeenAt: { gt: new Date(Date.now() - DEVICE_OFFLINE_MS) },
    },
    orderBy: { lastSeenAt: 'desc' },
    select,
  })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const appId = process.env.AGORA_APP_ID?.trim()
  const appCertificate = process.env.AGORA_APP_CERTIFICATE?.trim()
  if (!appId || !appCertificate) {
    return Response.json({ error: 'agora_not_configured' }, { status: 503 })
  }

  // The owner's master Mac kill switch gates token minting exactly like the
  // stream and frames endpoints — a disabled daemon must not be able to open
  // a video channel (Codex P1).
  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_disabled' }, { status: 409 })
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
  const owner = await getJwt(req)
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (!(await resolveOwnerUserIds()).includes(owner.sub)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { deviceId?: string; uid?: number }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const device = await findOwnedViewerDevice(owner.sub, String(body.deviceId ?? '').trim() || undefined)
  if (!device) return Response.json({ error: 'no_device' }, { status: 404 })

  const channel = `mac-screen-${device.id}`
  // RC-1: a caller may RENEW for the uid it is already joined with (stepping
  // back down from control to view-only, or refreshing before expiry). Only a
  // uid this server minted qualifies — otherwise a fresh one, as before.
  const requested = Number(body.uid)
  const renewing = Number.isInteger(requested) && requested > 0
    && (await isKnownViewUid(device.id, requested))
  const uid = renewing ? requested : 1000 + Math.floor(Math.random() * 100000)
  const token = RtcTokenBuilder.buildTokenWithUid(
    appId, appCertificate, channel, uid, RtcRole.SUBSCRIBER, TOKEN_TTL_SEC, expire,
  )
  // RC-1: remember the uid we just minted. Arming control later renews the
  // token on THIS connection (no rejoin, no video blackout), and the control
  // route will only mint for a uid it finds in this register — so the phone
  // can never name a uid of its own choosing.
  await registerViewUid(device.id, uid)
  return Response.json({ appId, channel, uid, token, expiresAt: expire })
}
