/**
 * M1 — daemon long-poll. The Mac daemon calls this on a loop with its bearer token
 * and gets back the next queued command, or nothing when idle.
 *
 * The daemon is NOT trusted to be the only gate: it re-classifies every command it
 * receives before running it. This endpoint's job is delivery, not permission.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, claimNextCommand, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
} as const

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // Kill-switch OFF ⇒ the daemon stays connected (so the owner sees it online and
  // can flip the switch back) but never receives work.
  if (!(await isMacAgentEnabled())) {
    return Response.json({ command: null, paused: true }, { headers: NO_STORE_HEADERS })
  }

  const command = await claimNextCommand(device.id)
  return Response.json({ command }, { headers: NO_STORE_HEADERS })
}
