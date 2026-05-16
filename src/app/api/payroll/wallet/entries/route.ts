import { NextRequest, NextResponse } from 'next/server'
import type { EmployeeLedgerEntryType } from '@prisma/client'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { WALLET_MANUAL_ENTRY_TYPES } from '@/lib/payroll-wallet'
import { createCompensationLedgerEntry, isDebitCompensationType } from '@/lib/payroll-compensation'

const TYPES: EmployeeLedgerEntryType[] = WALLET_MANUAL_ENTRY_TYPES

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    employee_id?: string
    business_id?: string
    type?: EmployeeLedgerEntryType
    amount?: number
    date?: string
    period_ym?: string
    note?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can create wallet entries.')
  if (ctx.role === 'ADMIN' && !['COMMISSION', 'EID_BONUS', 'PERFORMANCE_BONUS', 'OVERTIME', 'REIMBURSEMENT', 'PENALTY', 'MEAL_DEDUCTION', 'ADJUSTMENT'].includes(String(body.type))) {
    return forbidden('Admins can post compensation entries only; salary accruals and payroll requests stay under HR/Super Admin flows.')
  }

  const type = body.type
  const employeeId = String(body.employee_id || '').trim()
  const amount = Number(body.amount || 0)
  if (!employeeId || !type || !TYPES.includes(type) || !Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: 'employee_id, valid type, and non-zero amount required' }, { status: 400 })
  }
  if (type !== 'ADJUSTMENT' && amount < 0) {
    return NextResponse.json({ error: `${type} amount must be positive. Use type semantics for deductions.` }, { status: 400 })
  }

  const entry = await createCompensationLedgerEntry({
    employeeId,
    businessId: ctx.businessIds[0],
    effectiveDate: body.date ? new Date(body.date) : new Date(),
    periodYm: body.period_ym || null,
    type,
    amount: isDebitCompensationType(type) ? Math.abs(amount) : amount,
    note: body.note,
    createdById: ctx.userId,
    approvedById: ctx.userId,
  })

  return NextResponse.json({ ok: true, entry })
}
