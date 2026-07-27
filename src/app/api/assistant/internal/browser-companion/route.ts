/**
 * POST /api/assistant/internal/browser-companion — run an approved browser task
 * inside the owner's own Chrome.
 *
 * The VPS worker cannot do this itself: the companion command bus lives in
 * Postgres and only the app talks to it. So the worker hands the task here and
 * holds the connection while the steps run, then reports the result through the
 * same job-result path every other job type uses.
 *
 * Internal-token auth only — this is worker-to-app, never a browser surface.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runBrowserTaskOnCompanion } from '@/agent/lib/browser/companion-bridge'
import type { BrowserTaskPayload } from '@/agent/lib/browser/actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A multi-step run in a real browser is slow; give it the platform's ceiling. */
export const maxDuration = 300

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as { payload?: BrowserTaskPayload } | null
  const payload = body?.payload
  if (!payload || !Array.isArray(payload.steps)) {
    return Response.json({ error: 'payload with steps is required' }, { status: 400 })
  }

  // Belt and braces on the routing rule: this endpoint exists only for tasks the
  // driver router pinned to the owner's own Chrome. A VPS-driver task arriving
  // here means something upstream is confused, and running it anyway would put a
  // task in the wrong browser — exactly what the router exists to prevent.
  if (payload.driver && payload.driver !== 'companion') {
    return Response.json({ error: `driver_mismatch — this endpoint runs companion tasks, got "${payload.driver}"` }, { status: 400 })
  }

  const result = await runBrowserTaskOnCompanion(payload)
  return Response.json(result, { status: result.ok ? 200 : 200 })
}
