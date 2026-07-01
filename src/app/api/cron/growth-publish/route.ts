// Growth Autopilot — scheduled-post publisher cron.
//
// Runs every few minutes. Finds calendar entries that the owner has APPROVED
// and whose scheduled time is due, publishes each to Facebook / Instagram,
// self-verifies, and records the outcome. Only 'approved' rows are ever
// touched — 'draft' (unapproved) rows are never published.
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/agent/config'
import { isGrowthAutopilotOn } from '@/agent/lib/growth/settings'
import { publishCalendarEntry } from '@/agent/lib/growth/publish'

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
  // Kill switch: if the agent is disabled, publish nothing.
  if (!isAgentEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'agent_disabled' })
  }
  // Module master switch (owner-tunable, no redeploy). Default ON.
  if (!(await isGrowthAutopilotOn())) {
    return NextResponse.json({ ok: true, skipped: 'growth_autopilot_off' })
  }

  const started = Date.now()
  const now = new Date()

  // Claim a small batch of due, approved posts. Order oldest-first.
  const due = await db.agentContentCalendar.findMany({
    where: { status: 'approved', scheduledFor: { lte: now } },
    orderBy: { scheduledFor: 'asc' },
    take: 5,
  })

  const results: Array<{ id: string; ok: boolean; postId?: string; error?: string }> = []

  for (const entry of due) {
    // Atomically claim this row so a concurrent cron invocation can't double-post.
    const claim = await db.agentContentCalendar.updateMany({
      where: { id: entry.id, status: 'approved' },
      data: { status: 'publishing' },
    })
    if (claim.count === 0) continue // someone else took it

    const outcome = await publishCalendarEntry({
      id: entry.id,
      platform: entry.platform,
      pageRef: entry.pageRef,
      caption: entry.caption,
      imageRef: entry.imageRef,
    })

    if (outcome.ok) {
      await db.agentContentCalendar.update({
        where: { id: entry.id },
        data: {
          status: 'published',
          postId: outcome.postId ?? null,
          permalinkUrl: outcome.permalinkUrl ?? null,
          publishedAt: new Date(),
          error: null,
        },
      })
    } else {
      await db.agentContentCalendar.update({
        where: { id: entry.id },
        data: { status: 'failed', error: (outcome.error ?? 'unknown').slice(0, 500) },
      })
    }
    results.push({ id: entry.id, ok: outcome.ok, postId: outcome.postId, error: outcome.error })
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    published: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    durationMs: Date.now() - started,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
