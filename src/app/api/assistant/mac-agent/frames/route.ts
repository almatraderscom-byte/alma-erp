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

  let body: { dataUri?: string }
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

  return Response.json({ ok: true, stop })
}
