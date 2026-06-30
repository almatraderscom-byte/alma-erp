/**
 * GET/POST /api/assistant/internal/winback-nudge — Vercel weekly cron.
 * Win-back + content-refresh proposals (owner-gated; proposes only, never acts).
 * Auth mirrors the other internal crons: Bearer CRON_SECRET (Vercel cron fires
 * GET) or AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runWinbackContentNudge } from '@/lib/winback-run'

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
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runWinbackContentNudge()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[winback-nudge]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
