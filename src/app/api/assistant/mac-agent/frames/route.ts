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
/** Drop the first capture after a scope rollover; it may have begun for the prior turn. */
const STREAM_SCOPE_SETTLE_MS = 1_200

interface StreamScopeRow {
  status: string
  turnId: string | null
  conversationId: string | null
  params: unknown
  deliveredAt: Date | null
  resolvedAt: Date | null
  createdAt: Date
}

interface ProducerStreamScope {
  streamCommandId: string
  turnId: string | null
  conversationId: string | null
}

export function inferMacFrameScope(row: StreamScopeRow | null): {
  turnId: string | null
  conversationId: string | null
  startedAt: Date | null
  active: boolean
  pending: boolean
} {
  // `delivered` is only a server-side claim; the poll response can be lost
  // before the daemon sees it. Never advance pixel ownership until the daemon
  // confirms the start by posting its command result (`done`).
  if (row?.status === 'delivered') {
    return { turnId: null, conversationId: null, startedAt: null, active: false, pending: true }
  }
  const params = (row?.params as { mode?: string } | null) ?? null
  if (!row || params?.mode !== 'start') {
    return { turnId: null, conversationId: null, startedAt: null, active: false, pending: false }
  }
  return {
    turnId: row.turnId?.trim() || null,
    conversationId: row.conversationId?.trim() || null,
    startedAt: row.resolvedAt ?? row.deliveredAt ?? row.createdAt,
    active: true,
    pending: false,
  }
}

export function macFrameScopeCanPublish(
  scope: Pick<ReturnType<typeof inferMacFrameScope>, 'active' | 'turnId' | 'conversationId'>,
  boundTurnRunning: boolean,
): boolean {
  if (!scope.active) return false
  const hasTurn = Boolean(scope.turnId)
  const hasConversation = Boolean(scope.conversationId)
  if (hasTurn !== hasConversation) return false
  // Legacy/manual streams are intentionally owner-controlled. Auto streams
  // remain alive only while their exact activity is still running.
  return !hasTurn || boundTurnRunning
}

export function inferProducerMacFrameScope(
  row: StreamScopeRow | null,
  producer: ProducerStreamScope,
  newerStopAt: Date | null = null,
): ReturnType<typeof inferMacFrameScope> | null {
  if (!row || (row.status !== 'delivered' && row.status !== 'done')) return null
  const params = (row.params as { mode?: string } | null) ?? null
  if (params?.mode !== 'start') return null
  if ((row.turnId?.trim() || null) !== producer.turnId) return null
  if ((row.conversationId?.trim() || null) !== producer.conversationId) return null
  if (newerStopAt && newerStopAt.getTime() > row.createdAt.getTime()) return null
  return {
    turnId: producer.turnId,
    conversationId: producer.conversationId,
    startedAt: row.resolvedAt ?? row.deliveredAt ?? row.createdAt,
    active: true,
    pending: false,
  }
}

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
    displays?: number
    displayIndex?: number
    controlSessionId?: string
    controlEvents?: number
    controlDrops?: number
    streamCommandId?: string
    turnId?: string | null
    conversationId?: string | null
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
  const streamCommandId = typeof body.streamCommandId === 'string'
    && body.streamCommandId.trim().length > 0
    && body.streamCommandId.length <= 200
    ? body.streamCommandId.trim()
    : null
  const producer = streamCommandId ? {
    streamCommandId,
    turnId: typeof body.turnId === 'string' && body.turnId.trim() ? body.turnId.trim() : null,
    conversationId: typeof body.conversationId === 'string' && body.conversationId.trim()
      ? body.conversationId.trim()
      : null,
  } : null
  // Scope is server-derived, never trusted from the daemon body. Include both
  // start and stop: a completed stop must not resurrect an older start's turn.
  // Queued next-turn starts are deliberately excluded so they cannot relabel
  // pixels from the stream that is still actually running.
  const scopeSelect = {
    turnId: true,
    conversationId: true,
    status: true,
    params: true,
    deliveredAt: true,
    resolvedAt: true,
    createdAt: true,
  }
  const scopeRow = await db.macAgentCommand.findFirst({
    where: producer ? {
      id: producer.streamCommandId,
      deviceId: device.id,
      action: 'screen_stream',
      status: { in: ['delivered', 'done'] },
    } : {
      deviceId: device.id,
      action: 'screen_stream',
      status: { in: ['delivered', 'done'] },
    },
    ...(producer ? {} : { orderBy: { createdAt: 'desc' } }),
    select: scopeSelect,
  }).catch(() => null) as StreamScopeRow | null
  const newerStop = producer && scopeRow
    ? await db.macAgentCommand.findFirst({
        where: {
          deviceId: device.id,
          action: 'screen_stream',
          status: { in: ['delivered', 'done'] },
          createdAt: { gt: scopeRow.createdAt },
          params: { path: ['mode'], equals: 'stop' },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }).catch(() => null) as { createdAt: Date } | null
    : null
  const scope = producer
    ? inferProducerMacFrameScope(scopeRow, producer, newerStop?.createdAt ?? null)
    : inferMacFrameScope(scopeRow)
  if (!scope) {
    return Response.json({ error: 'stale_stream_scope' }, { status: 409 })
  }
  const boundTurnRunning = scope.turnId && scope.conversationId
    ? Boolean(await db.agentTurn.findFirst({
        where: {
          id: scope.turnId,
          conversationId: scope.conversationId,
          status: 'running',
        },
        select: { id: true },
      }).catch(() => null))
    : false
  const scopeCanPublish = macFrameScopeCanPublish(scope, boundTurnRunning)
  const settling = !producer
    && Boolean(scope.startedAt && at.getTime() - scope.startedAt.getTime() < STREAM_SCOPE_SETTLE_MS)

  let storedFrame: { sequence: number } | null = null
  if (scopeCanPublish && !settling) {
    storedFrame = await db.macAgentFrame.upsert({
      where: { deviceId: device.id },
      create: {
        deviceId: device.id,
        dataUri,
        at,
        turnId: scope.turnId,
        conversationId: scope.conversationId,
        sequence: 1,
      },
      update: {
        dataUri,
        at,
        turnId: scope.turnId,
        conversationId: scope.conversationId,
        sequence: { increment: 1 },
      },
      select: { sequence: true },
    })
  }
  // L9-B: the daemon says its VIDEO broadcaster is live (heartbeats seen).
  // Kept in KV (no migration): freshness is the truth — the feed treats a
  // stamp older than ~10s as video-off, so a crashed broadcaster self-heals.
  if (body.video === true && storedFrame) {
    await db.agentKvSetting
      .upsert({
        where: { key: `mac_video_active:${device.id}` },
        create: {
          key: `mac_video_active:${device.id}`,
          value: JSON.stringify({
            at: at.toISOString(),
            turnId: scope.turnId,
            conversationId: scope.conversationId,
          }),
        },
        update: {
          value: JSON.stringify({
            at: at.toISOString(),
            turnId: scope.turnId,
            conversationId: scope.conversationId,
          }),
        },
      })
      .catch(() => {})
  }
  // RC-3: how many screens this Mac has, and which one is being sent. Kept in
  // KV beside the video stamp so the dock can offer a picker only when there
  // is actually something to pick.
  if (Number.isInteger(body.displays)) {
    const value = JSON.stringify({
      count: Math.max(1, Math.min(8, Number(body.displays))),
      index: Math.max(0, Math.min(7, Number(body.displayIndex) || 0)),
      at: at.toISOString(),
    })
    await db.agentKvSetting
      .upsert({
        where: { key: `mac_displays:${device.id}` },
        create: { key: `mac_displays:${device.id}`, value },
        update: { value },
      })
      .catch(() => {})
  }
  // The stop side-channel: the daemon's command queue is SERIAL, so a queued
  // stop would wait behind a long-running shell command while frames kept
  // flowing (Codex on the L7 PR). This POST arrives every ~1.5s from the very
  // loop we want to stop — answer it with the stop and settle the command.
  let stop = false
  const pendingStop = await db.macAgentCommand
    .findFirst({
      where: { deviceId: device.id, action: 'screen_stream', status: 'queued' },
      orderBy: { createdAt: 'asc' },
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
  if (!scopeCanPublish && !scope.pending) stop = true

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

  return Response.json({ ok: true, stop, control: stop ? null : control, stored: Boolean(storedFrame) })
}
