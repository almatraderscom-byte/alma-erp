/**
 * Phase E — extension long-poll. The companion calls this on a loop with its bearer
 * token; we hand back the next queued command (or nothing when idle). The companion
 * is "dumb + obedient": all gating already happened before a command was enqueued.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateDevice,
  claimNextCommand,
  isLiveBrowserEnabled,
} from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // Kill-switch OFF ⇒ stay connected but never dispatch work.
  if (!(await isLiveBrowserEnabled())) {
    return Response.json({ command: null, paused: true })
  }

  const cmd = await claimNextCommand(device.id)
  return Response.json({ command: cmd })
}
