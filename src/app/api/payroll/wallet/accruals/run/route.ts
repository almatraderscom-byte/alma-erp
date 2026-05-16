import { NextRequest, NextResponse } from 'next/server'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { runPayrollAccrual } from '@/lib/payroll-accrual'
import { periodFromDate } from '@/lib/payroll-wallet'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { business_id?: string; period_ym?: string; force?: boolean }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can run payroll accruals.')

  const periodYm = body.period_ym || periodFromDate()
  const results = await Promise.all(
    ctx.businessIds.map(businessId => runPayrollAccrual({ businessId, periodYm, runById: ctx.userId, trigger: 'manual', force: body.force === true })),
  )

  return NextResponse.json({ ok: results.every(r => r.ok), periodYm, results })
}
