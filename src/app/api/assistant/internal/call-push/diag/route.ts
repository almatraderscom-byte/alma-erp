/**
 * Owner-only diagnostic: is the server's call-push wake layer actually wired?
 *   GET /api/assistant/internal/call-push/diag
 *     → { apnsConfigured, apnsProbe: { status, reason }, fcmConfigured, registered }
 *
 * The apnsProbe sends a VoIP push to a FAKE device token and reports APNs's
 * verdict WITHOUT delivering anything real:
 *   • reason 'BadDeviceToken'      → the .p8 / key id / team id are correct ✅
 *   • reason 'InvalidProviderToken'→ the pasted key/ids are wrong ❌
 *   • reason 'apns_unconfigured'   → env vars missing on this deployment
 * Lets us confirm the Vercel paste is intact before burning a device build.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { apnsVoipConfigured, sendVoipCall } from '@/agent/lib/apns-voip'
import { fcmCallConfigured } from '@/agent/lib/fcm-call'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'owner_only' }, { status: 403 })

  const apnsConfigured = apnsVoipConfigured()
  let apnsProbe: { status?: number; reason?: string; ok?: boolean } = { reason: 'skipped' }
  if (apnsConfigured) {
    const fake = '0'.repeat(64)
    const res = await sendVoipCall([fake], {
      type: 'office_call',
      broadcastId: 'diag',
      channel: 'itc_diag',
      caller: 'diag',
    })
    const r = res[0]
    apnsProbe = { status: r?.status, reason: r?.reason, ok: r?.ok }
  }

  // How many devices are registered for call push (informational).
  let registered = 0
  try {
    registered = await prisma.pushSubscription.count({
      where: { enabled: true, provider: { in: ['apns_voip', 'fcm'] } },
    })
  } catch {
    /* ignore */
  }

  return Response.json({
    apnsConfigured,
    apnsProbe,
    fcmConfigured: fcmCallConfigured(),
    registered,
  })
}
