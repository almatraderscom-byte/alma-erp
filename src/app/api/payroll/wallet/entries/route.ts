import { NextRequest, NextResponse } from 'next/server'
import type { EmployeeLedgerEntryType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { moneyDecimal, periodFromDate } from '@/lib/payroll-wallet'

const TYPES: EmployeeLedgerEntryType[] = ['SALARY_ACCRUAL', 'ADVANCE', 'WITHDRAWAL', 'ADJUSTMENT', 'BONUS', 'PENALTY']

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

  const type = body.type
  const employeeId = String(body.employee_id || '').trim()
  const amount = Number(body.amount || 0)
  if (!employeeId || !type || !TYPES.includes(type) || !Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: 'employee_id, valid type, and non-zero amount required' }, { status: 400 })
  }

  const entry = await prisma.employeeLedgerEntry.create({
    data: {
      employeeId,
      businessId: ctx.businessIds[0],
      date: body.date ? new Date(body.date) : new Date(),
      periodYm: type === 'SALARY_ACCRUAL' ? (body.period_ym || periodFromDate(body.date ? new Date(body.date) : new Date())) : null,
      type,
      amount: moneyDecimal(amount),
      note: body.note?.slice(0, 800) || null,
      createdById: ctx.userId,
      approvedById: ctx.userId,
      source: 'manual_entry',
      sourceRef: `manual:${crypto.randomUUID()}`,
    },
  })

  return NextResponse.json({ ok: true, entry })
}
