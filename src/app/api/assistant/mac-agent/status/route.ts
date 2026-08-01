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
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  cancelAllQueued,
  createPairingTicket,
  isMacAgentEnabled,
  listDevices,
  recentCommands,
  revokeDevice,
  setMacAgentEnabled,
} from '@/agent/lib/mac-agent/bus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(owner)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { owner }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const gate = await requireOwner(req)
  if (gate.error) return gate.error

  const [enabled, devices, history] = await Promise.all([
    isMacAgentEnabled(),
    listDevices(),
    recentCommands(20),
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
      const ticket = await createPairingTicket(body.deviceName)
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
    const cancelled = await cancelAllQueued(body.deviceId)
    // The red STOP must also kill a RUNNING screen stream, not only queued
    // commands — the capture timer lives outside the queue. Broadcast to
    // EVERY online Mac: picking one guesses wrong with two paired machines
    // (Codex, L7 round 3), and a stop where nothing streams is a no-op.
    // Enqueued AFTER the cancel so it survives it; the frame loop settles it
    // off the side-channel within ~1.5s.
    try {
      const { listDevices, enqueueCommand } = await import('@/agent/lib/mac-agent/bus')
      for (const d of (await listDevices()).filter((x) => x.online && x.pairedAt)) {
        await enqueueCommand({ deviceId: d.id, action: 'screen_stream', params: { mode: 'stop' } })
      }
    } catch {
      /* stream stop is additive to STOP; the deadline still bounds capture */
    }
    return Response.json({ ok: true, cancelled })
  }

  if (action === 'unpair') {
    const deviceId = String(body.deviceId ?? '').trim()
    if (!deviceId) return Response.json({ error: 'deviceId_required' }, { status: 400 })
    await revokeDevice(deviceId)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
