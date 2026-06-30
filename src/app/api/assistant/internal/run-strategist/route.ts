/**
 * GET/POST /api/assistant/internal/run-strategist — Vercel daily cron.
 * Daily cross-domain strategy pass — owner-gated proposals only (proposes, never
 * auto-acts). Auth mirrors the other internal crons: Bearer CRON_SECRET (Vercel
 * cron fires GET) or AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runDailyStrategist } from '@/lib/strategist-run'

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
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runDailyStrategist()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[run-strategist]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
