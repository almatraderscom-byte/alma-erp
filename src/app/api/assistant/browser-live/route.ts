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
import { isLiveViewEnabled, LIVE_VIEW_ENABLED_KEY } from '@/agent/lib/browser/live-client'

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
    case 'start': {
      // Opening a browser is the only action that creates new load on the box
      // carrying the phone calls, so it is the one gated by the kill-switch.
      // Stopping, clearing and reading stay available even when it is off —
      // switching a capability off must never strand a running session.
      if (!(await isLiveViewEnabled())) {
        return Response.json(
          {
            error: 'browser_live_disabled',
            // "লাইভ ব্রাউজার" alone is ambiguous — the owner's own Chrome is called
            // that too, and it has its own separate switch. Name the machine.
            message:
              'VPS ব্রাউজার এখন বন্ধ আছে, Boss। চালু করতে বলুন — "VPS ব্রাউজার চালু করো" ' +
              `(settings: ${LIVE_VIEW_ENABLED_KEY} = true)। ` +
              'এটা আপনার Mac-এর Chrome নয় — সেটার সুইচ আলাদা (live_browser_enabled)।',
          },
          { status: 403 },
        )
      }
      return callLive('/live/start', {
        method: 'POST',
        body: { startUrl: body.startUrl, goal: body.goal, profile: body.profile },
        timeoutMs: 45_000,
      })
    }
    case 'stop':
      return callLive('/live/stop', { method: 'POST', timeoutMs: 15_000 })
    case 'input':
      // One owner gesture — a click, a keystroke, a scroll. Passed straight
      // through; the VPS side is what validates and applies it.
      return callLive('/live/input', { method: 'POST', body: body.event ?? {}, timeoutMs: 15_000 })
    case 'profiles':
      return callLive('/profiles', { method: 'GET', timeoutMs: 20_000 })
    case 'purge':
      // Clearing saved logins is the owner's call, and deliberately reachable:
      // a cleanup he cannot trigger himself is a cleanup he cannot trust.
      return callLive('/profiles/purge', {
        method: 'POST',
        body: { key: body.key, all: body.all === true, cachesOnly: body.cachesOnly === true },
        timeoutMs: 60_000,
      })
    case 'enforce':
      return callLive('/profiles/enforce', { method: 'POST', timeoutMs: 60_000 })
    default:
      return Response.json({ error: `unknown action: ${action || '(none)'}` }, { status: 400 })
  }
}
