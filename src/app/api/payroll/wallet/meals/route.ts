import { NextRequest, NextResponse } from 'next/server'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    business_id?: string
    employee_ids?: string[]
    amount?: number
    total_amount?: number
    company_paid?: boolean
    note?: string
    date?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can post meal deductions.')

  const employeeIds = [...new Set((body.employee_ids || []).map(id => String(id).trim()).filter(Boolean))]
  if (!employeeIds.length) return NextResponse.json({ error: 'employee_ids required' }, { status: 400 })

  if (body.company_paid) {
    return NextResponse.json({
      ok: true,
      companyPaid: true,
      createdCount: 0,
      message: 'Company-paid meal recorded without employee wallet deduction.',
    })
  }

  const customAmount = Number(body.amount || 0)
  const splitTotal = Number(body.total_amount || 0)
  const deduction = customAmount > 0 ? customAmount : splitTotal > 0 ? splitTotal / employeeIds.length : 0
  if (!Number.isFinite(deduction) || deduction <= 0) {
    return NextResponse.json({ error: 'amount or total_amount required for deducted meals' }, { status: 400 })
  }

  const entries = await Promise.all(employeeIds.map(employeeId => createCompensationLedgerEntry({
    employeeId,
    businessId: ctx.businessIds[0],
    type: 'MEAL_DEDUCTION',
    amount: deduction,
    effectiveDate: body.date ? new Date(body.date) : new Date(),
    note: body.note || (employeeIds.length > 1 ? `Group meal deduction split across ${employeeIds.length} employees` : 'Meal deduction'),
    createdById: ctx.userId,
    approvedById: ctx.userId,
  })))

  return NextResponse.json({ ok: true, createdCount: entries.length, entries })
}
