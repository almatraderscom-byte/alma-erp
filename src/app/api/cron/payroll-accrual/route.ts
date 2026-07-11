import { NextRequest, NextResponse } from 'next/server'
import { BUSINESS_LIST } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { runPayrollAccrual } from '@/lib/payroll-accrual'
import { payrollAccrualPeriodYm } from '@/lib/payroll-wallet'
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
  const periodYm = payrollAccrualPeriodYm(now)
  if (!setting.enabled) {
    return NextResponse.json({ ok: true, skipped: 'automation_disabled', periodYm })
  }
  if (day !== setting.dayOfMonth) {
    return NextResponse.json({ ok: true, skipped: 'not_scheduled_day', scheduledDay: setting.dayOfMonth, currentDay: day, periodYm })
  }

  try {
    // Owner rule 2026-07-11: held businesses (e.g. Trading while it's off) are
    // skipped by the auto-run; unholding via automation settings resumes them.
    const held = new Set(setting.heldBusinessIds ?? [])
    const active = BUSINESS_LIST.filter(b => !held.has(b.id))
    const results = await Promise.all(
      active.map(b => runPayrollAccrual({ businessId: b.id, periodYm, trigger: 'cron' })),
    )
    return NextResponse.json({ ok: results.every(r => r.ok), periodYm, results, heldBusinessIds: [...held] })
  } catch (e) {
    logEvent('error', 'payroll_cron_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
