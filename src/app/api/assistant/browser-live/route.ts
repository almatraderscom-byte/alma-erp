/**
 * GET  /api/assistant/browser-live        — is a live session running, and what is it doing
 * POST /api/assistant/browser-live        — start / stop / send one input event
 *
 * Owner-only. The live browser itself lives on the VPS; this is the relay
 * (see ./relay.ts for why the frames cannot go direct).
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { callLive, requireOwner } from './relay'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const denied = await requireOwner(req)
  if (denied) return denied

  return callLive('/live/status', { method: 'GET', timeoutMs: 8000 })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const denied = await requireOwner(req)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = String(body.action ?? '')

  switch (action) {
    case 'start':
      return callLive('/live/start', {
        method: 'POST',
        body: { startUrl: body.startUrl, goal: body.goal },
        timeoutMs: 45_000,
      })
    case 'stop':
      return callLive('/live/stop', { method: 'POST', timeoutMs: 15_000 })
    case 'input':
      // One owner gesture — a click, a keystroke, a scroll. Passed straight
      // through; the VPS side is what validates and applies it.
      return callLive('/live/input', { method: 'POST', body: body.event ?? {}, timeoutMs: 15_000 })
    default:
      return Response.json({ error: `unknown action: ${action || '(none)'}` }, { status: 400 })
  }
}
