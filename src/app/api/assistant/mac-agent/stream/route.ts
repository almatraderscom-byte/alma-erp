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
import { revokeControl } from '@/agent/lib/mac-agent/remote-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { on?: boolean; maxSeconds?: number; displayIndex?: number }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 })
  }
  // STOP broadcasts to EVERY online Mac: guessing the streamer from frames
  // fails when a start is still queued (no frame yet) or a stale frame points
  // at the wrong machine, and "most recently seen" flaps under frame POSTs —
  // Codex found each of those in turn. A stop where nothing streams is a
  // harmless no-op, so the broadcast is simply correct.
  if (body.on === false) {
    const online = (await listDevices()).filter((d) => d.online && d.pairedAt)
    if (online.length === 0) {
      return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
    }
    // A start still QUEUED behind a long command would outlive an appended
    // stop (FIFO) and begin capturing after the owner cancelled it (Codex,
    // L7 round 5) — cancel pending starts first, then broadcast the stop for
    // any loop already running.
    const { prisma } = await import('@/lib/prisma')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).macAgentCommand
      .updateMany({
        where: { action: 'screen_stream', status: 'queued' },
        data: { status: 'cancelled', error: 'superseded_by_stop', resolvedAt: new Date() },
      })
      .catch(() => {})
    const ids: string[] = []
    for (const d of online) {
      // RC-1: stopping the view also drops any control grant. Video off means
      // hands off — the owner should never have to press two stops.
      await revokeControl(d.id, 'stream_stop')
      const { id } = await enqueueCommand({
        deviceId: d.id,
        action: 'screen_stream',
        params: { mode: 'stop' },
      })
      ids.push(id)
    }
    return Response.json({ ok: true, commandIds: ids, on: false })
  }

  const device = await activeDevice()
  if (!device) {
    return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
  }
  const { id } = await enqueueCommand({
    deviceId: device.id,
    action: 'screen_stream',
    params: {
      mode: 'start',
      maxSeconds: Number(body.maxSeconds) || undefined,
      // RC-3: which screen, when the Mac has more than one.
      displayIndex: Number.isInteger(body.displayIndex) ? body.displayIndex : undefined,
    },
  })
  return Response.json({ ok: true, commandId: id, on: true, deviceId: device.id })
}
