/**
 * GET /api/assistant/internal/watchdog — Vercel cron (every 10 min).
 * Checks worker heartbeats; stale >5 min → Tier 2 notify to owner.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { HEARTBEAT_STALE_MS } from '@/agent/lib/constants'
import { captureAgentEvent } from '@/agent/lib/sentry'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { scanStaffSendFailures } from '@/agent/lib/notif-failure-scan'
import { runReminderFallbackDispatch } from '@/agent/lib/reminder-fallback'

export const runtime = 'nodejs'
export const maxDuration = 30

const WATCHED = ['telegram-bot', 'schedulers', 'queue-consumer'] as const

function authorized(req: NextRequest): boolean {
  const cron = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (cron) {
    try {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(cron))) return true
    } catch { /* length mismatch */ }
  }
  const internal = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (internal) {
    try {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(internal))) return true
    } catch { /* length mismatch */ }
  }
  return false
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const stale: string[] = []
  const status: Record<string, { lastBeatAt: string | null; stale: boolean }> = {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  let rows: Array<{ service: string; lastBeatAt: Date }> = []
  try {
    rows = await db.agentHeartbeat.findMany({
      where: { service: { in: [...WATCHED] } },
    })
  } catch (err) {
    await captureAgentEvent('error', 'agent.watchdog.db_failed', { error: String(err) })
    return NextResponse.json({ error: 'heartbeat_table_unavailable' }, { status: 500 })
  }

  const byService = new Map(rows.map((r) => [r.service, r]))

  for (const service of WATCHED) {
    const row = byService.get(service)
    const lastBeatAt = row?.lastBeatAt?.toISOString() ?? null
    const ageMs = row ? now - new Date(row.lastBeatAt).getTime() : Infinity
    const isStale = ageMs > HEARTBEAT_STALE_MS
    status[service] = { lastBeatAt, stale: isStale }
    if (isStale) stale.push(service)
  }

  if (stale.length > 0) {
    const msg = `Worker service(s) silent >5 min: ${stale.join(', ')}. Check VPS: pm2 logs agent-worker`
    await notifyOwner({ tier: 2, category: 'urgent', title: 'Worker down', message: msg })
    await captureAgentEvent('warn', 'agent.watchdog.stale', { stale, status })
  }

  // Reminder fallback: any reminder the worker ticker left unsent 3+ min past due
  // fires from here (Telegram/ntfy), so a dead worker can never swallow a promised
  // reminder. Isolated so a send/DB error never breaks the heartbeat check.
  let reminderFallback: { sent: number; failed: number } = { sent: 0, failed: 0 }
  try {
    reminderFallback = await runReminderFallbackDispatch()
    if (reminderFallback.sent > 0) {
      await captureAgentEvent('warn', 'agent.watchdog.reminder_fallback_sent', { ...reminderFallback })
    }
  } catch (err) {
    await captureAgentEvent('error', 'agent.watchdog.reminder_fallback_failed', { error: String(err) })
  }

  // Staff send-failure detection: alert the owner when queued staff messages
  // exhaust every retry. Isolated so a queue/DB error never breaks the heartbeat check.
  let staffFailures: { failed: number; alerted: boolean } = { failed: 0, alerted: false }
  try {
    const scan = await scanStaffSendFailures()
    staffFailures = { failed: scan.failed, alerted: scan.alerted }
    if (scan.alerted) {
      await captureAgentEvent('warn', 'agent.watchdog.staff_send_failures', { failed: scan.failed })
    }
  } catch (err) {
    await captureAgentEvent('error', 'agent.watchdog.failure_scan_failed', { error: String(err) })
  }

  // LG-9 slice 2: the watchdog's verdict lands on the day's duty thread
  // (fail-open inside). Healthy ticks checkpoint too — silence is a finding.
  try {
    const { mirrorDutyTick } = await import('@/agent/lib/graph/duty-run-graph')
    const { todayYmdDhaka } = await import('@/lib/agent-api/dhaka-date')
    await mirrorDutyTick('watchdog', todayYmdDhaka(), {
      decision: stale.length > 0 ? 'alerted' : staffFailures.alerted ? 'staff_failures' : 'healthy',
      outcome: stale.length > 0 || staffFailures.failed > 0 ? 'blocked' : 'active',
      summary:
        [
          stale.length ? `stale: ${stale.join(',')}` : null,
          reminderFallback.sent ? `reminder fallback sent: ${reminderFallback.sent}` : null,
          staffFailures.failed ? `staff send failures: ${staffFailures.failed}` : null,
        ]
          .filter(Boolean)
          .join(' | ') || null,
      costUsd: 0,
      conversationId: null,
    })
  } catch { /* mirror must never break the watchdog */ }

  return NextResponse.json({
    ok: stale.length === 0 && staffFailures.failed === 0,
    checkedAt: new Date().toISOString(),
    stale,
    status,
    staffFailures,
    reminderFallback,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
