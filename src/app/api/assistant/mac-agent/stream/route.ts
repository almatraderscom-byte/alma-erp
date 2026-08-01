/**
 * L7 — the owner's start/stop for live screen streaming, from the dock.
 *
 * Owner-session only (cookie auth, like live-activity and session-reply).
 * The gate IS this explicit tap: the daemon never starts a capture loop on
 * its own, the loop self-stops at its deadline, and the kill-switch stops it
 * mid-flight. A capture loop is read-only on the Mac — green by construction,
 * gated by consent rather than the classifier.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { activeDevice, enqueueCommand, isMacAgentEnabled, listDevices } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { on?: boolean; maxSeconds?: number }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 })
  }
  // STOP must reach the Mac that is actually streaming — with two Macs
  // online, "most recently seen" flaps (the frame POSTs themselves bump
  // lastSeenAt) and a stop could land on the idle machine as a no-op while
  // the other kept capturing (Codex on the L7 PR). The newest frame names
  // the streamer.
  let device = null
  if (body.on === false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const streamer = await db.macAgentFrame
      .findFirst({
        where: { at: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
        orderBy: { at: 'desc' },
        select: { deviceId: true },
      })
      .catch(() => null)
    if (streamer) {
      device = (await listDevices()).find((d) => d.id === streamer.deviceId && d.online) ?? null
    }
  }
  device = device ?? (await activeDevice())
  if (!device) {
    return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
  }

  const { id } = await enqueueCommand({
    deviceId: device.id,
    action: 'screen_stream',
    params: body.on === false
      ? { mode: 'stop' }
      : { mode: 'start', maxSeconds: Number(body.maxSeconds) || undefined },
  })
  return Response.json({ ok: true, commandId: id, on: body.on !== false, deviceId: device.id })
}
