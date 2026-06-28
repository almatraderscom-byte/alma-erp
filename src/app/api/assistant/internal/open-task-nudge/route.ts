/**
 * GET/POST /api/assistant/internal/open-task-nudge — Vercel cron.
 *
 * Reminds the owner about open-loop tasks left unfinished: 30 min after a task
 * is tracked, then again at 60 min if it's still open. One consolidated Telegram
 * message per tick. Safe no-op when nothing is due.
 *
 * Auth mirrors the other internal crons: Bearer CRON_SECRET (Vercel cron) or
 * AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { isAgentEnabled } from '@/agent/config'
import { captureAgentError } from '@/agent/lib/sentry'
import { runOpenTaskNudgeTick } from '@/agent/lib/open-task'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
    const result = await runOpenTaskNudgeTick(businessId)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    await captureAgentError(err, 'open_task_nudge_tick', { route: 'open-task-nudge' })
    return NextResponse.json({ ok: false, error: 'tick_failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
