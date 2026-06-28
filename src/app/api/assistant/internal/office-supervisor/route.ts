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
import { SUPERVISED_BUSINESSES } from '@/agent/lib/constants'

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
  if (!isAgentEnabled()) return NextResponse.json({ ok: false, disabled: true })

  // A bare cron fire (no ?businessId) sweeps every supervised business; an explicit
  // ?businessId targets just one (manual re-run). Businesses run in parallel so a
  // slow Lifestyle tick never starves the Trading (money) tick within the budget.
  const param = req.nextUrl.searchParams.get('businessId')?.trim()
  const businesses = param ? [param] : [...SUPERVISED_BUSINESSES]

  const settled = await Promise.allSettled(businesses.map((businessId) => runSupervisorTick({ businessId })))
  const results = await Promise.all(
    settled.map(async (s, i) => {
      if (s.status === 'fulfilled') return s.value
      await captureAgentError(s.reason, 'office_supervisor_tick', {
        route: `office-supervisor:${businesses[i]}`,
      })
      return { businessId: businesses[i], ran: false, error: 'tick_failed' }
    }),
  )
  return NextResponse.json({ ok: true, businesses: results })
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
