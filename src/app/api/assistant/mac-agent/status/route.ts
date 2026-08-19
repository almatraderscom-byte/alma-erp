/**
 * M1 — owner-facing control surface for Mac control.
 *
 * GET  → devices, online state, kill-switch, recent command history (the audit
 *        trail he can read without a terminal).
 * POST → owner actions: generate a pairing code, flip the kill-switch, STOP
 *        (cancel everything queued), or unpair a Mac.
 *
 * Owner-session only (not the daemon's bearer token) — this is the human side.
 */
import { randomBytes } from 'crypto'
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { getJwt } from '@/lib/api-guards'
import { isSystemOwner } from '@/lib/roles'
import {
  authenticateDevice,
  enqueueCommand,
  isMacAgentEnabled,
  setMacAgentEnabled,
} from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEVICE_OFFLINE_MS = 90_000
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = (length: number) => Array.from(randomBytes(length))
    .map((byte) => alphabet[byte % alphabet.length])
    .join('')
  return `${pick(4)}-${pick(4)}`
}

async function createOwnedPairingTicket(ownerUserId: string, deviceName?: string) {
  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)
  const name = (deviceName ?? '').trim() || 'My Mac'
  const device = await prisma.macAgentDevice.create({
    data: { ownerUserId, name, pairingCode: code, pairingExp: expiresAt },
    select: { id: true },
  })
  return { deviceId: device.id, code, expiresAt, deviceName: name }
}

async function listOwnedDevices(ownerUserId: string) {
  const rows = await prisma.macAgentDevice.findMany({
    where: { ownerUserId, revoked: false },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, name: true, lastSeenAt: true, pairedAt: true, meta: true },
  })
  return rows.map((device) => ({
    id: device.id,
    name: device.name,
    online: Boolean(
      device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() < DEVICE_OFFLINE_MS,
    ),
    lastSeenAt: device.lastSeenAt,
    pairedAt: device.pairedAt,
    meta: (device.meta as Record<string, unknown> | null) ?? null,
  }))
}

async function recentOwnedCommands(ownerUserId: string, limit = 20) {
  const rows = await prisma.macAgentCommand.findMany({
    where: { device: { ownerUserId } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(1, limit), 100),
    select: {
      id: true,
      action: true,
      params: true,
      policyLevel: true,
      status: true,
      exitCode: true,
      createdAt: true,
    },
  })
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    command: ((row.params as Record<string, unknown> | null)?.command as string) ?? null,
    policyLevel: row.policyLevel,
    status: row.status,
    exitCode: row.exitCode,
    createdAt: row.createdAt,
  }))
}

async function requireOwner(req: NextRequest) {
  const owner = await getJwt(req)
  if (!owner?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(owner)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  if (!(await resolveOwnerUserIds()).includes(owner.sub)) {
    return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { ownerId: owner.sub }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  // W3 — the daemon's out-of-band STOP/kill-switch check. A ui_* verb waiting
  // out the owner-at-keyboard gate blocks the serial command queue, so the
  // poll's `paused` flag goes stale; this lightweight Bearer-authenticated
  // read is how the wait learns the owner pressed STOP (the row it is
  // executing went `cancelled`) or flipped the switch. Token-authenticated
  // per-request exactly like /poll — it returns only the enabled flag and the
  // status of the daemon's OWN command, never the owner-page payload below.
  const auth = req.headers.get('authorization') ?? ''
  if (auth.startsWith('Bearer ')) {
    const device = await authenticateDevice(auth.slice(7).trim())
    if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const enabled = await isMacAgentEnabled()
    const commandId = req.nextUrl.searchParams.get('commandId')
    let commandStatus: string | null = null
    if (commandId) {
      const row = await prisma.macAgentCommand.findFirst({
        where: { id: commandId, deviceId: device.id },
        select: { status: true },
      })
      commandStatus = row?.status ?? 'missing'
    }
    return Response.json({ enabled, commandStatus })
  }

  const gate = await requireOwner(req)
  if (gate.error) return gate.error

  const [enabled, devices, history] = await Promise.all([
    isMacAgentEnabled(),
    listOwnedDevices(gate.ownerId),
    recentOwnedCommands(gate.ownerId, 20),
  ])
  return Response.json({ enabled, devices, history })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const gate = await requireOwner(req)
  if (gate.error) return gate.error

  let body: { action?: string; deviceName?: string; deviceId?: string; enabled?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = String(body.action ?? '')

  if (action === 'pair_code') {
    try {
      const ticket = await createOwnedPairingTicket(gate.ownerId, body.deviceName)
      return Response.json({ ok: true, ...ticket })
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'pair_failed' },
        { status: 500 },
      )
    }
  }

  if (action === 'set_enabled') {
    const enabled = await setMacAgentEnabled(Boolean(body.enabled))
    return Response.json({ ok: true, enabled })
  }

  if (action === 'stop') {
    const deviceId = String(body.deviceId ?? '').trim() || undefined
    const cancelledResult = await prisma.macAgentCommand.updateMany({
      where: {
        status: { in: ['queued', 'delivered'] },
        ...(deviceId ? { deviceId } : {}),
        device: { ownerUserId: gate.ownerId },
      },
      data: { status: 'cancelled', error: 'cancelled_by_owner', resolvedAt: new Date() },
    })
    const cancelled = cancelledResult.count
    // The red STOP must also kill a RUNNING screen stream, not only queued
    // commands — the capture timer lives outside the queue. Broadcast to
    // EVERY online Mac: picking one guesses wrong with two paired machines
    // (Codex, L7 round 3), and a stop where nothing streams is a no-op.
    // Enqueued AFTER the cancel so it survives it; the frame loop settles it
    // off the side-channel within ~1.5s.
    try {
      const onlineDevices = await prisma.macAgentDevice.findMany({
        where: {
          ownerUserId: gate.ownerId,
          revoked: false,
          pairedAt: { not: null },
          lastSeenAt: { gt: new Date(Date.now() - DEVICE_OFFLINE_MS) },
        },
        select: { id: true },
      })
      for (const d of onlineDevices) {
        await enqueueCommand({ deviceId: d.id, action: 'screen_stream', params: { mode: 'stop' } })
        // W3: app-chat mirrors are timers outside the queue too — same
        // broadcast rule. (A deferring ui_* action learns of the STOP from
        // the cancelled row it re-checks; this stops the watchers.) The cast
        // is deliberate: MAC_AGENT_ACTIONS lives in bus.ts, which W4 (#679)
        // is extending with the ui_* verbs on its own branch — W4 should fold
        // 'app_mirror' into that list and this cast then disappears.
        await enqueueCommand({
          deviceId: d.id,
          action: 'app_mirror' as unknown as Parameters<typeof enqueueCommand>[0]['action'],
          params: { mode: 'stop_all' },
        })
      }
    } catch {
      /* stream stop is additive to STOP; the deadline still bounds capture */
    }
    return Response.json({ ok: true, cancelled })
  }

  if (action === 'unpair') {
    const deviceId = String(body.deviceId ?? '').trim()
    if (!deviceId) return Response.json({ error: 'deviceId_required' }, { status: 400 })
    const revoked = await prisma.macAgentDevice.updateMany({
      where: { id: deviceId, ownerUserId: gate.ownerId, revoked: false },
      data: { revoked: true, tokenHash: null },
    })
    if (revoked.count === 0) return Response.json({ error: 'no_device' }, { status: 404 })
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
