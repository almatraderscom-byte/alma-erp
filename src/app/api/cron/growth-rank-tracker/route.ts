// Growth Autopilot — weekly keyword rank tracker cron.
//
// For every ACTIVE tracked keyword (cost-capped), pulls the Google (Bangladesh)
// SERP, records where almatraders.com ranks, and pushes the owner a Bangla
// summary with week-over-week movement. Spends Oxylabs credits, so it is gated
// behind the owner's `growth.rankTracking` switch (default OFF) on top of the
// global AGENT_ENABLED kill switch.
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/agent/config'
import { isRankTrackingOn, RANK_TRACKING_MAX_KEYWORDS } from '@/agent/lib/growth/settings'
import { oxylabsConfigured, oxylabsSerpSearch, logOxylabsUsage } from '@/lib/oxylabs/client'
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

function arrow(prev: number | null, now: number | null): string {
  if (now === null) return prev === null ? '—' : '⬇️ (টপ ১০-এর বাইরে)'
  if (prev === null) return `#${now} (নতুন)`
  if (now < prev) return `#${now} ⬆️ (+${prev - now})`
  if (now > prev) return `#${now} ⬇️ (-${now - prev})`
  return `#${now} ➡️`
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isAgentEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'agent_disabled' })
  }
  if (!(await isRankTrackingOn())) {
    return NextResponse.json({ ok: true, skipped: 'rank_tracking_off' })
  }
  if (!oxylabsConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'oxylabs_not_configured' })
  }

  const started = Date.now()
  const tracked = await db.agentTrackedKeyword.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    take: RANK_TRACKING_MAX_KEYWORDS,
  })
  if (tracked.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, note: 'no active tracked keywords' })
  }

  const lines: string[] = []
  let processed = 0

  for (const kw of tracked) {
    const keyword = String(kw.keyword)
    try {
      // Previous observation for this keyword (before we write the new one).
      const prev = await db.agentKeywordRank.findFirst({
        where: { keyword },
        orderBy: { checkedAt: 'desc' },
      })

      const res = await oxylabsSerpSearch(keyword, { limit: 10, geoLocation: 'Bangladesh' })
      void logOxylabsUsage({ tool: 'growth_rank_tracker', query: keyword, success: res.success })
      if (!res.success) {
        lines.push(`• ${keyword}: SERP আনা যায়নি`)
        continue
      }
      const results = res.results ?? []
      let rank: number | null = null
      let url: string | null = null
      for (const r of results) {
        if (r.url.includes('almatraders.com')) {
          rank = r.pos
          url = r.url
          break
        }
      }
      await db.agentKeywordRank.create({
        data: {
          keyword,
          productSlug: kw.productSlug ?? null,
          rank,
          url,
          foundInTop10: rank !== null,
          top10: results.slice(0, 10).map((r) => ({ pos: r.pos, url: r.url, title: r.title })),
        },
      })
      lines.push(`• ${keyword}: ${arrow(prev?.rank ?? null, rank)}`)
      processed++
    } catch (err) {
      lines.push(`• ${keyword}: ত্রুটি`)
      console.warn(`[rank-tracker] ${keyword} failed:`, err instanceof Error ? err.message : err)
    }
  }

  const text = `🔎 সাপ্তাহিক কীওয়ার্ড র‍্যাঙ্ক (almatraders.com — Google BD)\n\n${lines.join('\n')}`
  const push = await sendOwnerText(text)

  return NextResponse.json({
    ok: true,
    processed,
    pushed: push.ok,
    pushError: push.ok ? undefined : push.error,
    durationMs: Date.now() - started,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
