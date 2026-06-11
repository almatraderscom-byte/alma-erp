import { NextRequest, NextResponse } from 'next/server'
import { reverseDuplicatePayrollAccruals } from '@/lib/payroll-accrual-reversal'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  const expected = process.env.CRON_SECRET || process.env.TRADING_SCREENSHOT_CLEANUP_SECRET
  return Boolean(expected && auth === `Bearer ${expected}`)
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized cron' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    period_ym?: string
    accrual_date?: string
    confirm?: boolean
  }

  try {
    const result = await reverseDuplicatePayrollAccruals({
      businessId: String(body.business_id || 'ALMA_LIFESTYLE').trim(),
      periodYm: String(body.period_ym || '2026-06').trim(),
      accrualDate: body.accrual_date || '2026-06-10',
      confirm: body.confirm === true,
    })
    logEvent('info', 'payroll_duplicate_accrual_reversal', {
      applied: result.applied,
      businessId: result.businessId,
      periodYm: result.periodYm,
      pendingReversalCount: result.pendingReversalCount,
      createdCount: result.createdCount,
    })
    return NextResponse.json(result)
  } catch (e) {
    logEvent('error', 'payroll_duplicate_accrual_reversal_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
