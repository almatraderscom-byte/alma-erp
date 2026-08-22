/** Device-authenticated security revocation for the Companion's Unpair action. */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateDevice,
  revokeDeviceSafely,
} from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bearer(req: NextRequest): string {
  const value = req.headers.get('authorization') ?? ''
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req), {
    allowRevocationPending: true,
  })
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const result = await revokeDeviceSafely(device.id)
  if (!result.revoked) {
    return Response.json({
      ok: false,
      stopping: true,
      inFlightEffects: result.inFlightEffects,
      message:
        'An already-authorized browser step is still finishing. The Companion is paused; retry Unpair after it settles.',
    }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } })
  }
  return Response.json({
    ok: true,
    revoked: true,
    stoppedQueuedOrDelivered: result.stoppedQueuedOrDelivered,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
