/**
 * GET/POST /api/assistant/internal/office-digest — Vercel cron.
 *
 * Once-a-day owner office digest: a plain-Bangla end-of-day wrap-up pushed to the
 * owner's Telegram. Scheduled near the office close (20:05 Asia/Dhaka via
 * vercel.json). Read-only — it never mutates tasks or touches money.
 *
 * Auth mirrors the supervisor cron: Bearer CRON_SECRET (Vercel cron) or
 * AGENT_INTERNAL_TOKEN. Honors the AGENT_ENABLED kill switch.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { isAgentEnabled } from '@/agent/config'
import { captureAgentError } from '@/agent/lib/sentry'
import { sendOwnerDigest } from '@/agent/lib/office-digest'
import { SUPERVISED_BUSINESSES } from '@/agent/lib/constants'

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
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAgentEnabled()) return NextResponse.json({ ok: false, disabled: true })

  // A bare cron fire (no ?businessId) sends a digest per supervised business; an
  // explicit ?businessId targets just one (manual re-run). sendOwnerDigest no-ops on
  // an empty day, so sweeping every business never spams the owner. Businesses run in
  // parallel so a slow Lifestyle digest never starves the Trading (money) digest.
  const param = req.nextUrl.searchParams.get('businessId')?.trim()
  const businesses = param ? [param] : [...SUPERVISED_BUSINESSES]

  const settled = await Promise.allSettled(businesses.map((businessId) => sendOwnerDigest(businessId)))
  const results = await Promise.all(
    settled.map(async (s, i) => {
      if (s.status === 'fulfilled') return { businessId: businesses[i], ...s.value }
      await captureAgentError(s.reason, 'office_digest', { route: `office-digest:${businesses[i]}` })
      return { businessId: businesses[i], pushed: false, error: 'digest_failed' }
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
