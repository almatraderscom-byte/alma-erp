/** Owner-session endpoint for a short, turn-bound Browser preview capture lease. */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import {
  cancelLiveBrowserTurn,
  renewBrowserPreviewLease,
} from '@/agent/lib/live-browser/companion'
import { getJwt } from '@/lib/api-guards'
import { prisma } from '@/lib/prisma'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface LeaseBody {
  conversationId?: unknown
  turnId?: unknown
  on?: unknown
}

function boundedId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  return id.length > 0 && id.length <= 200 ? id : ''
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const owner = await getJwt(req)
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner) || !(await resolveOwnerUserIds()).includes(owner.sub)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: LeaseBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const turnId = boundedId(body.turnId)
  const conversationId = boundedId(body.conversationId)
  if (!turnId || !conversationId || typeof body.on !== 'boolean') {
    return Response.json({ error: 'turn_conversation_and_on_required' }, { status: 400 })
  }

  const ownedDevices = await prisma.liveBrowserDevice.findMany({
    where: { ownerUserId: owner.sub, revoked: false, pairedAt: { not: null } },
    select: { id: true },
  })
  const ownedDeviceIds = ownedDevices.map((device) => device.id)
  if (body.on === false) {
    // In a witnessed lane, turning preview off also stops browser work. The
    // cancel transaction shares command/device locks; if one effect is already
    // executing we return `stopping` and keep its lease alive until it finishes.
    const stopped = await cancelLiveBrowserTurn(turnId)
    if ((stopped.inFlightEffects ?? 0) > 0) {
      return Response.json({
        ok: false,
        stopping: true,
        inFlightEffects: stopped.inFlightEffects,
      }, { status: 202 })
    }
    if (!stopped.found) return Response.json({ error: 'turn_not_running' }, { status: 409 })
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const turn = await prisma.agentTurn.findFirst({
    where: { id: turnId, conversationId, status: 'running' },
    select: { id: true },
  })
  if (!turn) return Response.json({ error: 'turn_not_running' }, { status: 409 })

  const sources = await prisma.liveBrowserCommand.findMany({
    where: { deviceId: { in: ownedDeviceIds }, turnId, conversationId },
    orderBy: { createdAt: 'desc' },
    distinct: ['deviceId'],
    take: 8,
    select: { deviceId: true, contextId: true },
  })
  if (sources.length === 0) {
    return Response.json({ error: 'browser_context_pending' }, { status: 409 })
  }
  const renewed = (await Promise.all(sources.map(async (source) => {
    const lease = await renewBrowserPreviewLease({ deviceId: source.deviceId, turnId, conversationId })
    return lease ? { source, lease } : null
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  if (renewed.length === 0) return Response.json({ error: 'turn_not_running' }, { status: 409 })
  const first = renewed[0]

  return Response.json({
    ok: true,
    // Singular fields preserve the initial native contract.
    deviceId: first.source.deviceId,
    contextId: first.source.contextId
      ? `browser:${first.source.deviceId}:${first.source.contextId}`
      : `browser:${first.source.deviceId}`,
    leaseExpiresAt: first.lease.expiresAt.toISOString(),
    leases: renewed.map(({ source, lease }) => ({
      deviceId: source.deviceId,
      contextId: source.contextId
        ? `browser:${source.deviceId}:${source.contextId}`
        : `browser:${source.deviceId}`,
      leaseExpiresAt: lease.expiresAt.toISOString(),
    })),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
