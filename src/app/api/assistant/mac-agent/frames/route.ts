/**
 * L7 — the daemon's screen-stream frames land here, one upsert per frame.
 *
 * One row per device, always the newest frame — the dock only ever wants
 * "now", and a frame every ~1.5s would otherwise write history nobody reads.
 * The live-activity feed serves it through the screenshot channel the docks
 * already render.
 *
 * Daemon bearer auth (constant-time), kill-switch enforced, and this path
 * must stay in middleware.ts's bypass list or auth never runs (the known
 * trap).
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'
import { readControlPin, recordControlCounts, revokeControl } from '@/agent/lib/mac-agent/remote-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Daemon downscales to fit; this is the server-side backstop. */
const MAX_FRAME_CHARS = 1_500_000

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled' }, { status: 409 })
  }

  const h = req.headers.get('authorization') ?? ''
  const device = await authenticateDevice(h.startsWith('Bearer ') ? h.slice(7).trim() : '')
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: {
    dataUri?: string
    video?: boolean
    controlSessionId?: string
    controlEvents?: number
    controlDrops?: number
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const dataUri = String(body.dataUri ?? '')
  if (!dataUri.startsWith('data:image') || dataUri.length > MAX_FRAME_CHARS) {
    return Response.json({ error: 'bad_frame' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const at = new Date()
  // L9-B: the daemon says its VIDEO broadcaster is live (heartbeats seen).
  // Kept in KV (no migration): freshness is the truth — the feed treats a
  // stamp older than ~10s as video-off, so a crashed broadcaster self-heals.
  if (body.video === true) {
    await db.agentKvSetting
      .upsert({
        where: { key: `mac_video_active:${device.id}` },
        create: { key: `mac_video_active:${device.id}`, value: at.toISOString() },
        update: { value: at.toISOString() },
      })
      .catch(() => {})
  }
  await db.macAgentFrame.upsert({
    where: { deviceId: device.id },
    create: { deviceId: device.id, dataUri, at },
    update: { dataUri, at },
  })

  // The stop side-channel: the daemon's command queue is SERIAL, so a queued
  // stop would wait behind a long-running shell command while frames kept
  // flowing (Codex on the L7 PR). This POST arrives every ~1.5s from the very
  // loop we want to stop — answer it with the stop and settle the command.
  let stop = false
  const pendingStop = await db.macAgentCommand
    .findFirst({
      where: { deviceId: device.id, action: 'screen_stream', status: 'queued' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, params: true },
    })
    .catch(() => null)
  if (pendingStop && (pendingStop.params as { mode?: string } | null)?.mode === 'stop') {
    stop = true
    await db.macAgentCommand
      .update({
        where: { id: pendingStop.id },
        data: {
          status: 'done',
          stdout: JSON.stringify({ streaming: false, via: 'frame_channel' }),
          resolvedAt: new Date(),
        },
      })
      .catch(() => {})
  }

  // RC-1: this same ~600ms POST is the control channel to the daemon. A
  // command-queue round trip would arm control seconds late (the queue is
  // serial and can sit behind a long shell command); the frame loop is
  // already running exactly when control matters.
  let control: { uid: number; sessionId: string; expiresAt: number } | null = null
  const pin = await readControlPin(device.id)
  if (pin) {
    control = {
      uid: pin.uid,
      sessionId: pin.sessionId,
      expiresAt: Math.floor(Date.parse(pin.expiresAt) / 1000),
    }
    if (body.controlSessionId === pin.sessionId) {
      await recordControlCounts(
        device.id, pin.sessionId,
        Math.max(0, Number(body.controlEvents) || 0),
        Math.max(0, Number(body.controlDrops) || 0),
      )
    }
  }
  // The stream is ending, so control ends with it — the injector IS the
  // broadcaster process. Close the audit row here rather than leaving it open
  // until the next grant.
  if (stop) await revokeControl(device.id, 'stream_stop', {
    events: Number(body.controlEvents) || undefined,
    drops: Number(body.controlDrops) || undefined,
  })

  return Response.json({ ok: true, stop, control: stop ? null : control })
}
