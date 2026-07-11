import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { runPayrollAccrual } from '@/lib/payroll-accrual'
import { payrollAccrualPeriodYm } from '@/lib/payroll-wallet'

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { business_id?: string; period_ym?: string; force?: boolean }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can run payroll accruals.')

  // Held businesses don't get salary runs — even manual ones. Unhold first
  // (automation settings) so paying a held business is always a two-step,
  // deliberate act.
  const setting = await prisma.payrollAutomationSetting.findUnique({ where: { id: 'global' } })
  const held = new Set(setting?.heldBusinessIds ?? [])
  const runnable = ctx.businessIds.filter(businessId => !held.has(businessId))
  if (!runnable.length) {
    return NextResponse.json(
      { error: 'এই বিজনেস পে-রোল হোল্ডে আছে — আগে টুলস → অটোমেশন থেকে হোল্ড তুলুন।' },
      { status: 400 },
    )
  }

  const periodYm = body.period_ym || payrollAccrualPeriodYm()
  const results = await Promise.all(
    runnable.map(businessId => runPayrollAccrual({ businessId, periodYm, runById: ctx.userId, trigger: 'manual', force: body.force === true })),
  )

  return NextResponse.json({ ok: results.every(r => r.ok), periodYm, results })
}
