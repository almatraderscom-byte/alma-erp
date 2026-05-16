import { NextRequest, NextResponse } from 'next/server'
import { BUSINESS_LIST } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { runPayrollAccrual } from '@/lib/payroll-accrual'
import { periodFromDate } from '@/lib/payroll-wallet'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  const expected = process.env.CRON_SECRET
  return expected && auth === `Bearer ${expected}`
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized cron' }, { status: 401 })
  }

  const setting = await prisma.payrollAutomationSetting.upsert({
    where: { id: 'global' },
    update: {},
    create: { id: 'global' },
  })

  const now = new Date()
  const day = now.getUTCDate()
  const periodYm = periodFromDate(now)
  if (!setting.enabled) {
    return NextResponse.json({ ok: true, skipped: 'automation_disabled', periodYm })
  }
  if (day !== setting.dayOfMonth) {
    return NextResponse.json({ ok: true, skipped: 'not_scheduled_day', scheduledDay: setting.dayOfMonth, currentDay: day, periodYm })
  }

  try {
    const results = await Promise.all(
      BUSINESS_LIST.map(b => runPayrollAccrual({ businessId: b.id, periodYm, trigger: 'cron' })),
    )
    return NextResponse.json({ ok: results.every(r => r.ok), periodYm, results })
  } catch (e) {
    logEvent('error', 'payroll_cron_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
