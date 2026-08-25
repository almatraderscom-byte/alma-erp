/**
 * GET /api/assistant/internal/turn-watchdog — reap stranded 'running' turns.
 *
 * A turn whose executing process died without finalizing (deploy restart,
 * crash, OOM) stays 'running' forever, and every client honestly shows
 * "কাজ চলছে — সংযোগ ফিরছে…" for as long as the owner looks at it (owner
 * incident 2026-08-26: 54 corpses back to June). The sweep finalizes any
 * running turn with no event activity for TURN_STALE_MS — the durable
 * terminal + live publish + row finalize settle every reconnecting client
 * within one poll. Genuinely alive long slices keep emitting events and are
 * never touched.
 *
 * Auth: Bearer CRON_SECRET.
 */
import { type NextRequest } from 'next/server'
import { isAgentEnabled } from '@/lib/agent-runtime-flag'
import { sweepStrandedTurns } from '@/agent/lib/turn-watchdog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  if (!isAgentEnabled()) return Response.json({ error: 'agent_disabled' }, { status: 503 })
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const result = await sweepStrandedTurns()
  if (result.reaped.length > 0) {
    console.warn(`[turn-watchdog] reaped ${result.reaped.length} stranded turn(s):`, result.reaped.join(', '))
  }
  return Response.json({ ok: true, ...result })
}
