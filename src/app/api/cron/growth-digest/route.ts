// Growth Autopilot — weekly analytics digest cron.
//
// Runs once a week. Ingests the trailing-7-day ads / content / catalog signals,
// snapshots them into agent_growth_metric (so week-over-week history builds up),
// and pushes a Bangla summary to the owner over Telegram. Read-only w.r.t. the
// business — it never publishes or spends.
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/agent/config'
import { buildWeeklyDigest } from '@/agent/lib/growth/digest'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

export const runtime = 'nodejs'
export const maxDuration = 120

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization')
  const internal = req.headers.get('x-alma-internal-token')
  return auth === `Bearer ${secret}` || (Boolean(process.env.AGENT_INTERNAL_TOKEN) && internal === process.env.AGENT_INTERNAL_TOKEN)
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Kill switch: if the agent is disabled, send nothing.
  if (!isAgentEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'agent_disabled' })
  }

  const started = Date.now()
  const digest = await buildWeeklyDigest()

  // Persist the snapshot for week-over-week history (best-effort).
  let snapshotId: string | null = null
  try {
    const row = await db.agentGrowthMetric.create({
      data: {
        source: 'weekly_digest',
        periodStart: digest.periodStart,
        periodEnd: digest.periodEnd,
        metrics: { ads: digest.ads, content: digest.content, catalog: digest.catalog },
      },
    })
    snapshotId = row.id
  } catch (err) {
    console.warn('[growth-digest] snapshot persist failed:', err instanceof Error ? err.message : err)
  }

  // Push the Bangla summary to the owner.
  const push = await sendOwnerText(digest.text)

  return NextResponse.json({
    ok: true,
    snapshotId,
    pushed: push.ok,
    pushError: push.ok ? undefined : push.error,
    durationMs: Date.now() - started,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
