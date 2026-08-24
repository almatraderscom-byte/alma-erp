import { NextRequest, NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'
import {
  confirmNudgeUrgencyForNow,
  sendPendingConfirmNudges,
  type ConfirmNudgeUrgency,
} from '@/lib/trading-telegram-confirm-nudge'

export const runtime = 'nodejs'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

/**
 * Warn staff before the day-cutoff lock takes their unconfirmed drafts.
 *
 * Scheduled twice (23:00 and 05:00 Dhaka). The urgency is derived from the BD
 * clock rather than from which cron entry fired, so moving
 * TELEGRAM_DRAFT_LOCK_HOUR_BD does not leave the schedule saying one thing and
 * the message another. `?urgency=` forces one for a manual test.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const forced = new URL(req.url).searchParams.get('urgency')?.toUpperCase()
  const urgency: ConfirmNudgeUrgency | null =
    forced === 'EVENING' || forced === 'FINAL' ? forced : confirmNudgeUrgencyForNow()

  if (!urgency) return NextResponse.json({ ok: true, skipped: 'outside nudge window' })

  try {
    const result = await sendPendingConfirmNudges(urgency)
    logEvent('info', 'trading.telegram.confirm_nudge', result)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    logEvent('error', 'trading.telegram.confirm_nudge_failed', { error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}
