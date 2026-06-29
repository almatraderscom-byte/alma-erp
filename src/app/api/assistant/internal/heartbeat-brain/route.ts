/**
 * GET/POST /api/assistant/internal/heartbeat-brain — Vercel cron.
 *
 * The autonomous "idle heartbeat" tick: the agent wakes on its own, takes a cheap
 * business pulse, and only wakes the head (Claude) when something actionable has
 * changed (see src/agent/lib/heartbeat/brain.ts for the cost gates). Scheduled a
 * few times a day during office hours via vercel.json; the enabled / office-hours /
 * change / daily-cap gates also live inside runHeartbeatTick, so an off-schedule or
 * off-hours fire is a safe near-free no-op.
 *
 * `?force=1` skips the gates (used by the owner's "test the heartbeat now" control).
 *
 * Auth mirrors the other internal crons: Bearer CRON_SECRET (Vercel cron) or
 * AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch (inside the tick).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { captureAgentError } from '@/agent/lib/sentry'
import { runHeartbeatTick } from '@/agent/lib/heartbeat/brain'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  for (const expected of [process.env.CRON_SECRET, process.env.AGENT_INTERNAL_TOKEN]) {
    if (!expected) continue
    try {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return true
    } catch {
      /* length mismatch */
    }
  }
  return false
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const force = ['1', 'true', 'yes'].includes((req.nextUrl.searchParams.get('force') ?? '').toLowerCase())
  try {
    const result = await runHeartbeatTick({ force })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    await captureAgentError(err, 'heartbeat_brain', { route: 'heartbeat-brain:route' })
    return NextResponse.json({ ok: false, error: 'tick_failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
