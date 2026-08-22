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
  LIVE_BROWSER_AUTHORIZE_PROTOCOL,
  markLiveBrowserDeviceUpdateRequired,
  reconcileStaleBrowserExecutions,
  supportsLiveBrowserAuthorizeProtocol,
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

  const protocol = req.headers.get('x-alma-companion-protocol')
  const supportsAuthorization = supportsLiveBrowserAuthorizeProtocol(protocol)
  const device = await authenticateDevice(bearer(req), {
    touchLastSeen: supportsAuthorization,
  })
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  if (!supportsAuthorization) {
    await markLiveBrowserDeviceUpdateRequired(device.id)
    return Response.json({
      command: null,
      preview: null,
      updateRequired: true,
      requiredProtocol: LIVE_BROWSER_AUTHORIZE_PROTOCOL,
    }, { status: 409, headers: NO_STORE_HEADERS })
  }

  // Kill-switch OFF ⇒ stay connected but never dispatch work.
  if (!(await isLiveBrowserEnabled())) {
    await reconcileStaleBrowserExecutions(device.id)
    return Response.json({ command: null, paused: true, preview: null }, { headers: NO_STORE_HEADERS })
  }

  // Claim returns the preview grant minted for this exact command in the same
  // transaction. Never compose a command with an independently read,
  // device-global lease from another turn/conversation.
  const cmd = await claimNextCommand(device.id, protocol)
  const lease = cmd?.preview ?? null
  // The deployed companion reads command fields FLAT (cmd.url, cmd.selector,
  // cmd.text, cmd.value, cmd.by, cmd.ms). Our bus stores them nested under
  // `params`, so flatten here — keeping the fix server-side means the owner
  // never has to reload the extension.
  // Params are model-produced payload. Durable row identity/action are
  // server-owned reserved fields and must win even if a malicious/stale row
  // contains colliding keys.
  const command = cmd ? { ...cmd.params, id: cmd.id, action: cmd.action } : null
  return Response.json({
    command,
    preview: lease ? {
      active: true,
      contextId: `browser:${device.id}`,
      turnId: lease.turnId,
      conversationId: lease.conversationId,
      expiresAt: lease.expiresAt.toISOString(),
      fps: 1,
      framePath: '/api/assistant/live-browser/frames',
    } : null,
  }, { headers: NO_STORE_HEADERS })
}
