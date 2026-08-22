/** Final device-authenticated pre-effect authorization for a polled command. */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateDevice,
  authorizeClaimedBrowserCommand,
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
  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { commandId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const commandId = typeof body.commandId === 'string' ? body.commandId.trim() : ''
  if (!commandId || commandId.length > 200) {
    return Response.json({ error: 'commandId_required' }, { status: 400 })
  }

  const decision = await authorizeClaimedBrowserCommand(device.id, commandId)
  return Response.json(decision, {
    status: decision.authorized ? 200 : 409,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
