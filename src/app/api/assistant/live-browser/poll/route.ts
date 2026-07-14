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

  // Kill-switch OFF ⇒ stay connected but never dispatch work.
  if (!(await isLiveBrowserEnabled())) {
    return Response.json({ command: null, paused: true }, { headers: NO_STORE_HEADERS })
  }

  const cmd = await claimNextCommand(device.id)
  // The deployed companion reads command fields FLAT (cmd.url, cmd.selector,
  // cmd.text, cmd.value, cmd.by, cmd.ms). Our bus stores them nested under
  // `params`, so flatten here — keeping the fix server-side means the owner
  // never has to reload the extension.
  const command = cmd ? { id: cmd.id, action: cmd.action, ...cmd.params } : null
  return Response.json({ command }, { headers: NO_STORE_HEADERS })
}
