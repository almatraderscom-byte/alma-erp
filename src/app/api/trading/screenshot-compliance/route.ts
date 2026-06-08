import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import {
  isPastScreenshotCutoff,
  screenshotComplianceStatus,
  screenshotUploadedToday,
  tradingBdDayBounds,
} from '@/lib/trading-compliance'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const expected = process.env.TRADING_SCREENSHOT_COMPLIANCE_SECRET || process.env.CRON_SECRET
  if (!expected || req.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isPastScreenshotCutoff()) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'before_cutoff' })
  }

  const { start, end } = tradingBdDayBounds()
  const accounts = await prisma.tradingAccount.findMany({
    where: { businessId: TRADING_BUSINESS_ID, status: 'ACTIVE', deletedAt: null },
    select: {
      id: true,
      accountTitle: true,
      assignedUserId: true,
      assignedUser: { select: { id: true, name: true, phone: true } },
      performanceShots: {
        where: { deletedAt: null, shotDate: { gte: start, lt: end } },
        select: { id: true },
        take: 1,
      },
    },
  })

  let notified = 0
  for (const account of accounts) {
    if (account.performanceShots.length > 0) continue
    const title = `${account.accountTitle}: screenshot overdue`
    const message = `Today's performance screenshot was not uploaded before the daily cutoff. Open Alma Trading and tap Upload Now.`
    const actionUrl = `/trading?action=screenshot&accountId=${account.id}`

    if (account.assignedUserId) {
      await notifyUser({
        userId: account.assignedUserId,
        businessId: TRADING_BUSINESS_ID,
        type: 'ADMIN_ANNOUNCEMENT',
        priority: 'HIGH',
        title,
        message,
        actionUrl,
      }).catch(() => {})
      notified += 1
    }

  }

  await notifyRole({
    role: 'SUPER_ADMIN',
    businessId: TRADING_BUSINESS_ID,
    type: 'ADMIN_ANNOUNCEMENT',
    priority: 'HIGH',
    title: 'Trading screenshot compliance',
    message: `${accounts.filter(a => !a.performanceShots.length).length} active account(s) missing today's screenshot.`,
    actionUrl: '/trading',
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    accountsChecked: accounts.length,
    missingToday: accounts.filter(a => !a.performanceShots.length).length,
    staffNotified: notified,
  })
}
