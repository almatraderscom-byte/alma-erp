import { NextRequest, NextResponse } from 'next/server'
import { BUSINESS_LIST } from '@/lib/businesses'
import { queueOpsDailySummary } from '@/lib/telegram-notification/daily-summary'
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
  const results = []
  for (const biz of BUSINESS_LIST) {
    results.push(await queueOpsDailySummary(biz.id))
  }
  const queue = await processTelegramNotificationQueue({ limit: 10 })
  return NextResponse.json({ ok: true, results, queue })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
