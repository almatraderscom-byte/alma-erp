import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, numberFromDecimal, summaryRange } from '@/lib/trading'
import { enqueueTradingDailySummarySms } from '@/services/sms/events'
import { processSmsQueue } from '@/lib/sms/queue'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.SMS_CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { start, end } = summaryRange('today')
  const rows = await prisma.tradingDailySnapshot.findMany({
    where: { businessId: TRADING_BUSINESS_ID, date: { gte: start, lt: end } },
    select: { grossProfitBdt: true, grossLossBdt: true, netResultBdt: true },
  })
  const summary = rows.reduce((acc, row) => {
    acc.profit += numberFromDecimal(row.grossProfitBdt)
    acc.loss += numberFromDecimal(row.grossLossBdt)
    acc.net += numberFromDecimal(row.netResultBdt)
    return acc
  }, { profit: 0, loss: 0, net: 0 })
  await enqueueTradingDailySummarySms(summary)
  const processed = await processSmsQueue({ limit: 5 })
  return NextResponse.json({ ok: true, summary, processed })
}
