import { NextRequest, NextResponse } from 'next/server'
import { runTelegramAttendanceMonitor } from '@/lib/telegram-attendance-monitor'
import { processTelegramNotificationQueue } from '@/lib/telegram-notification/queue'

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
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const monitor = await runTelegramAttendanceMonitor()
  const queue = await processTelegramNotificationQueue({ limit: 20 })
  return NextResponse.json({ ok: true, monitor, queue })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
