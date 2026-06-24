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
    const result = await sendOwnerDigest(businessId)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    await captureAgentError(err, 'office_digest', { route: 'office-digest' })
    return NextResponse.json({ ok: false, error: 'digest_failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
