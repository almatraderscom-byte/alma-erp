import { NextRequest, NextResponse } from 'next/server'
import { processSmsQueue, refreshSmsDeliveryReports } from '@/lib/sms/queue'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.SMS_CRON_SECRET
  if (!secret) return false
  return req.headers.get('x-cron-secret') === secret
    || req.headers.get('authorization') === `Bearer ${secret}`
    || req.nextUrl.searchParams.get('secret') === secret
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [queue, reports] = await Promise.all([
    processSmsQueue({ limit: 10 }),
    refreshSmsDeliveryReports(20),
  ])
  return NextResponse.json({ ok: true, queue, reports })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
