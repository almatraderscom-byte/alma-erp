import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { notifyTradingScreenshotUploaded } from '@/lib/telegram-notification/screenshot-notify'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return (
    req.headers.get('x-cron-secret') === secret
    || req.headers.get('authorization') === `Bearer ${secret}`
    || req.nextUrl.searchParams.get('secret') === secret
  )
}

/** Backfill or test screenshot Telegram notify for one upload. */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { screenshotId?: string }
  if (!body.screenshotId) {
    return NextResponse.json({ error: 'screenshotId required' }, { status: 400 })
  }

  const shot = await prisma.tradingPerformanceScreenshot.findFirst({
    where: { id: body.screenshotId, deletedAt: null },
    include: {
      tradingAccount: { select: { id: true, accountTitle: true } },
      uploader: { select: { name: true } },
    },
  })
  if (!shot) return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 })

  const result = await notifyTradingScreenshotUploaded({
    businessId: shot.businessId,
    screenshotId: shot.id,
    accountId: shot.tradingAccountId,
    accountTitle: shot.tradingAccount.accountTitle,
    uploaderName: shot.uploader?.name || 'Staff',
    shotDate: shot.shotDate.toISOString().slice(0, 10),
  })

  return NextResponse.json({ ok: true, result })
}
