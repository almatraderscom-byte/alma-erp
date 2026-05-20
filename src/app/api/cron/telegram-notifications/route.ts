import { NextRequest, NextResponse } from 'next/server'
import { processTelegramNotificationQueue } from '@/lib/telegram-notification/queue'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return (
    req.headers.get('x-cron-secret') === secret
    || req.headers.get('authorization') === `Bearer ${secret}`
    || req.nextUrl.searchParams.get('secret') === secret
  )
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    logTelegram('error', 'telegram.cron.misconfigured', { reason: 'CRON_SECRET_MISSING' })
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const queue = await processTelegramNotificationQueue({ limit: 25 })
  logTelegram('info', 'telegram.cron.processed', {
    processed: queue.processed,
    stuckSending: queue.stuckSending,
    durationMs: Date.now() - started,
  })
  return NextResponse.json({ ok: true, queue })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
