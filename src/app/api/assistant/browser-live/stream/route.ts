/**
 * GET /api/assistant/browser-live/stream — the live frames, relayed.
 *
 * Server-Sent Events straight through from the VPS service: this route opens one
 * upstream stream and pipes its bytes to the owner untouched, so a frame is not
 * buffered, re-encoded or re-framed on the way. Owner-only.
 *
 * A relayed stream cannot outlive the serverless function that carries it, so
 * expect the client to reconnect periodically — the browser session on the VPS is
 * unaffected by that and keeps its page state across reconnects.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { liveBase, requireOwner } from '../relay'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Vercel caps a streaming function; reconnects are normal, not an error state. */
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const denied = await requireOwner(req)
  if (denied) return denied

  const base = liveBase()
  if (!base) {
    return Response.json({ error: 'browser_live_not_configured' }, { status: 503 })
  }

  // ?fps= lets one viewer take fewer frames than the session produces — a phone
  // on mobile data. Forwarded, because dropping it here would quietly hand that
  // phone the full-rate stream it just asked not to get.
  const fps = new URL(req.url).searchParams.get('fps')
  const upstreamUrl = `${base}/live/stream${fps ? `?fps=${encodeURIComponent(fps)}` : ''}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN ?? ''}` },
      signal: req.signal, // the owner closing the tab tears down the upstream too
      cache: 'no-store',
    })
  } catch (err) {
    return Response.json(
      { error: 'browser_live_unreachable', message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    return new Response(text || JSON.stringify({ error: 'no live session' }), {
      status: upstream.status || 502,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the whole point of a live view.
      'x-accel-buffering': 'no',
    },
  })
}
