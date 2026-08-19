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
import { Prisma } from '@prisma/client'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { getJwt } from '@/lib/api-guards'
import { isSystemOwner } from '@/lib/roles'
import { enqueueCommand, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'
import { revokeControl } from '@/agent/lib/mac-agent/remote-control'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_OFFLINE_MS = 90_000

async function listOwnedDevices(ownerUserId: string) {
  return prisma.macAgentDevice.findMany({
    where: { ownerUserId, revoked: false },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, pairedAt: true, lastSeenAt: true },
  })
}

function isOnline(lastSeenAt: Date | null): boolean {
  return Boolean(lastSeenAt && Date.now() - lastSeenAt.getTime() < DEVICE_OFFLINE_MS)
}

export type ComputerUseStartDecision = 'reuse_auto' | 'respect_manual' | 'enqueue_auto'

export function computerUseStartDecision(input: {
  status?: string | null
  params?: Record<string, unknown> | null
  createdAt?: Date | null
  frameAt?: Date | null
  forceRenew?: boolean
  now?: number
}): ComputerUseStartDecision {
  const now = input.now ?? Date.now()
  if (input.params?.mode !== 'start') return 'enqueue_auto'
  const auto = input.params.reason === 'computer_use'
  if (input.forceRenew && auto) return 'enqueue_auto'
  const pending = input.status === 'queued' || input.status === 'delivered'
  if (pending) return auto ? 'reuse_auto' : 'respect_manual'
  const frameFresh = Boolean(input.frameAt && now - input.frameAt.getTime() < 10_000)
  if (!auto) return frameFresh ? 'respect_manual' : 'enqueue_auto'
  // A fresh bus-prepended start needs one short probe to establish ownership.
  // Later probes enqueue a start, which the daemon interprets as lease extension.
  const recentlyStarted = Boolean(input.createdAt && now - input.createdAt.getTime() < 15_000)
  return recentlyStarted && frameFresh ? 'reuse_auto' : 'enqueue_auto'
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getJwt(req)
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })
  if (!(await resolveOwnerUserIds()).includes(owner.sub)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    on?: boolean
    maxSeconds?: number
    displayIndex?: number
    deviceId?: string
    reason?: string
    turnId?: string
    conversationId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 })
  }
  const requestedDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
  const reason = body.reason === 'computer_use' ? 'computer_use' : 'owner_manual'
  const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : ''
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
  const requestedDisplayIndex = Number.isInteger(body.displayIndex)
    && Number(body.displayIndex) >= 0
    && Number(body.displayIndex) <= 7
    ? Number(body.displayIndex)
    : null
  if (reason === 'computer_use' && (!turnId || !conversationId || turnId.length > 200 || conversationId.length > 200)) {
    return Response.json({ error: 'turn_conversation_required' }, { status: 400 })
  }
  if (reason === 'computer_use' && !requestedDeviceId) {
    return Response.json({ error: 'deviceId_required' }, { status: 400 })
  }
  // STOP broadcasts to EVERY online Mac: guessing the streamer from frames
  // fails when a start is still queued (no frame yet) or a stale frame points
  // at the wrong machine, and "most recently seen" flaps under frame POSTs —
  // Codex found each of those in turn. A stop where nothing streams is a
  // harmless no-op, so the broadcast is simply correct.
  if (body.on === false) {
    const ownedDevices = await listOwnedDevices(owner.sub)
    const selected = requestedDeviceId
      ? ownedDevices.filter((device) => device.id === requestedDeviceId)
      : ownedDevices
    if (requestedDeviceId && selected.length === 0) {
      return Response.json({ error: 'device_not_found' }, { status: 404 })
    }
    const online = selected.filter((d) => isOnline(d.lastSeenAt) && d.pairedAt)
    if (reason === 'computer_use') {
      const stop = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`mac-stream:${requestedDeviceId}`}))`)
        const newest = await tx.macAgentCommand.findFirst({
          where: { deviceId: requestedDeviceId, action: 'screen_stream' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, params: true, turnId: true, conversationId: true },
        })
        const params = (newest?.params as Record<string, unknown> | null) ?? null
        const sameScope = params?.reason === 'computer_use'
          && newest?.turnId === turnId
          && newest?.conversationId === conversationId
        // Idempotent retry: if the first stop response was lost, the exact
        // owner still receives a truthful owned/off acknowledgement.
        if (params?.mode === 'stop' && sameScope) {
          return { owned: true, on: false, commandId: newest?.id ?? null }
        }
        const owns = params?.mode === 'start' && sameScope
        if (!owns) return { owned: false, on: params?.mode === 'start', commandId: null }
        await tx.macAgentCommand.updateMany({
          where: {
            deviceId: requestedDeviceId,
            action: 'screen_stream',
            status: 'queued',
            params: { path: ['mode'], equals: 'start' },
            turnId,
            conversationId,
          },
          data: { status: 'cancelled', error: 'superseded_by_stop', resolvedAt: new Date() },
        })
        if (online.length === 0) return { owned: true, on: false, commandId: null }
        const row = await tx.macAgentCommand.create({
          data: {
            deviceId: requestedDeviceId,
            action: 'screen_stream',
            params: { mode: 'stop', reason: 'computer_use' },
            turnId,
            conversationId,
            policyLevel: 'green',
          },
          select: { id: true },
        })
        return { owned: true, on: false, commandId: row.id }
      }, { isolationLevel: 'Serializable' })
      if (!stop.owned) {
        return Response.json({
          ok: true, on: stop.on, ignored: 'stream_owner_changed', autoOwned: false,
          deviceId: requestedDeviceId, turnId, conversationId,
        })
      }
      if (online.length > 0) await revokeControl(requestedDeviceId, 'stream_stop')
      return Response.json({
        ok: true,
        commandIds: stop.commandId ? [stop.commandId] : [],
        on: false,
        autoOwned: true,
        deviceId: requestedDeviceId,
        turnId,
        conversationId,
        ...(online.length === 0 ? { cancelledQueued: true } : {}),
      })
    }
    // A start still QUEUED behind a long command would outlive an appended
    // stop (FIFO) and begin capturing after the owner cancelled it (Codex,
    // L7 round 5) — cancel pending starts first, then broadcast the stop for
    // any loop already running.
    await prisma.macAgentCommand
      .updateMany({
        where: {
          deviceId: { in: selected.map((device) => device.id) },
          action: 'screen_stream',
          status: 'queued',
          ...(requestedDeviceId ? { params: { path: ['mode'], equals: 'start' } } : {}),
        },
        data: { status: 'cancelled', error: 'superseded_by_stop', resolvedAt: new Date() },
      })
      .catch(() => {})
    if (online.length === 0) {
      return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
    }
    const ids: string[] = []
    for (const d of online) {
      // RC-1: stopping the view also drops any control grant. Video off means
      // hands off — the owner should never have to press two stops.
      await revokeControl(d.id, 'stream_stop')
      const { id } = await enqueueCommand({
        deviceId: d.id,
        action: 'screen_stream',
        params: { mode: 'stop', reason },
      })
      ids.push(id)
    }
    return Response.json({
      ok: true,
      commandIds: ids,
      on: false,
    })
  }

  const device = await prisma.macAgentDevice.findFirst({
    where: {
      ...(requestedDeviceId ? { id: requestedDeviceId } : {}),
      ownerUserId: owner.sub,
      revoked: false,
      pairedAt: { not: null },
      lastSeenAt: { gt: new Date(Date.now() - DEVICE_OFFLINE_MS) },
    },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true },
  })
  if (!device) {
    return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
  }
  if (reason === 'computer_use') {
    const turn = await prisma.agentTurn.findFirst({
      where: { id: turnId, conversationId, status: 'running' },
      select: { id: true },
    })
    if (!turn) return Response.json({ error: 'turn_not_running' }, { status: 409 })
    const [existing, frame] = await Promise.all([
      prisma.macAgentCommand.findFirst({
        where: { deviceId: device.id, action: 'screen_stream' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, params: true, status: true, createdAt: true,
          turnId: true, conversationId: true,
        },
      }),
      prisma.macAgentFrame.findUnique({
        where: { deviceId: device.id },
        select: { at: true, turnId: true, conversationId: true },
      }),
    ])
    const params = (existing?.params as Record<string, unknown> | null) ?? null
    const sameAutoOwner = params?.reason === 'computer_use'
      && existing?.turnId === turnId
      && existing?.conversationId === conversationId
    const sameOwnerFrameAt = frame?.turnId === turnId
      && frame?.conversationId === conversationId
      ? frame.at
      : null
    const foreignActive = params?.mode === 'start' && !sameAutoOwner
      && (existing?.status === 'queued' || existing?.status === 'delivered'
        || Boolean(frame?.at && Date.now() - frame.at.getTime() < 10_000))
    const decision = foreignActive ? 'respect_manual' : computerUseStartDecision({
      status: existing?.status,
      params: sameAutoOwner ? params : null,
      createdAt: existing?.createdAt,
      frameAt: sameOwnerFrameAt,
      // A display change is an explicit same-owner start/renew command. The
      // daemon switches ScreenCaptureKit while retaining this exact activity.
      forceRenew: requestedDisplayIndex !== null && sameAutoOwner,
    })
    if (existing && decision !== 'enqueue_auto') {
      const autoOwned = decision === 'reuse_auto'
      return Response.json({
        ok: true,
        commandId: existing.id,
        on: true,
        deviceId: device.id,
        alreadyStarted: true,
        autoOwned,
        turnId,
        conversationId,
      })
    }
  }
  const { id } = await enqueueCommand({
    deviceId: device.id,
    action: 'screen_stream',
    params: {
      mode: 'start',
      maxSeconds: Number(body.maxSeconds) || undefined,
      // RC-3: which screen, when the Mac has more than one.
      displayIndex: requestedDisplayIndex ?? undefined,
      reason,
    },
    ...(reason === 'computer_use' ? { turnId, conversationId } : {}),
  })
  return Response.json({
    ok: true,
    commandId: id,
    on: true,
    deviceId: device.id,
    ...(reason === 'computer_use' ? { autoOwned: true } : {}),
    ...(reason === 'computer_use' ? { turnId, conversationId } : {}),
  })
}
