/**
 * GET/POST /api/assistant/internal/office-supervisor — Vercel cron.
 *
 * The autonomous office supervisor tick. Scheduled during office hours only
 * (09:30–20:00 Asia/Dhaka via vercel.json); the office-hours gate also lives
 * inside runSupervisorTick so off-hours invocations are a safe no-op.
 *
 * Auth mirrors the watchdog cron: Bearer CRON_SECRET (Vercel cron) or
 * AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { isAgentEnabled } from '@/agent/config'
import { captureAgentError } from '@/agent/lib/sentry'
import { runSupervisorTick } from '@/agent/lib/office-supervisor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

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

  const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
  try {
    const result = await runSupervisorTick({ businessId })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    await captureAgentError(err, 'office_supervisor_tick', { route: 'office-supervisor' })
    return NextResponse.json({ ok: false, error: 'tick_failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
