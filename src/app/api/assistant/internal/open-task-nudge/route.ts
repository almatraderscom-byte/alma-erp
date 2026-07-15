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
    // P0 watchdog rides the same cron: stuck worker jobs → checkpoint + one ping.
    let watchdog: { stuck: number; pinged: number } = { stuck: 0, pinged: 0 }
    try {
      const { runStuckTaskWatchdogTick } = await import('@/agent/lib/checkpoint')
      watchdog = await runStuckTaskWatchdogTick()
    } catch (wdErr) {
      await captureAgentError(wdErr, 'stuck_task_watchdog_tick', { route: 'open-task-nudge' })
    }
    // P1 §5.6 retention: live-browser command rows (params/results may embed page
    // data and screenshot dataURLs) are auto-deleted after 7 days.
    try {
      const { prisma } = await import('@/lib/prisma')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).liveBrowserCommand.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      })
    } catch { /* table may not exist yet on old DBs — best-effort */ }
    // LG-2 retention: stale LangGraph checkpoint threads (roadmap: TTL cleanup
    // from day 1). No-ops when the checkpointer gate is off; best-effort.
    try {
      const { cleanupGraphCheckpoints } = await import('@/agent/lib/graph/graph-checkpointer')
      await cleanupGraphCheckpoints()
    } catch { /* best-effort */ }
    return NextResponse.json({ ok: true, ...result, watchdog })
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
