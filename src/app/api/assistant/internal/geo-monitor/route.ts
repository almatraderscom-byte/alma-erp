/**
 * GET/POST /api/assistant/internal/geo-monitor — Vercel cron.
 *
 * Office-hours geofence sweep: alerts the owner when a supervised staffer who was
 * inside the office geofence moves outside. Scheduled during office hours only
 * (every 10 min, 03:30–14:00 UTC ≈ 09:30–20:00 Asia/Dhaka via vercel.json); the
 * office-hours gate also lives inside runGeoFenceSweep so off-hours fires no-op.
 *
 * Auth mirrors the supervisor/digest crons: Bearer CRON_SECRET (Vercel cron) or
 * AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { isAgentEnabled } from '@/agent/config'
import { captureAgentError } from '@/agent/lib/sentry'
import { runGeoFenceSweep } from '@/agent/lib/geo-fence-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  if (!isAgentEnabled()) return NextResponse.json({ ok: false, disabled: true })

  try {
    const result = await runGeoFenceSweep()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    await captureAgentError(err, 'geo_monitor', { route: 'geo-monitor' })
    return NextResponse.json({ ok: false, error: 'geo_sweep_failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
