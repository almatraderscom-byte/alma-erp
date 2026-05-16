import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { periodFromDate } from '@/lib/payroll-wallet'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const periodYm = url.searchParams.get('period_ym') || periodFromDate()
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can preview payroll accruals.')

  const users = await prisma.user.findMany({
    where: {
      active: true,
      employeeIdGas: { not: null },
      businessAccess: { contains: ctx.businessIds[0] },
    },
    select: { id: true, name: true, email: true, employeeIdGas: true, salaryHint: true },
    orderBy: { name: 'asc' },
  })

  const existing = await prisma.employeeLedgerEntry.findMany({
    where: { businessId: ctx.businessIds[0], periodYm, type: 'SALARY_ACCRUAL' },
    select: { employeeId: true },
  })
  const existingSet = new Set(existing.map(e => e.employeeId))
  const employees = users.map(u => ({
    userId: u.id,
    employeeId: u.employeeIdGas,
    name: u.name,
    email: u.email,
    salary: Number(u.salaryHint || 0),
    alreadyAccrued: u.employeeIdGas ? existingSet.has(u.employeeIdGas) : false,
  }))

  return NextResponse.json({
    businessId: ctx.businessIds[0],
    periodYm,
    employees,
    totalPreviewSalary: employees.reduce((a, e) => a + (e.alreadyAccrued ? 0 : e.salary), 0),
    alreadyAccruedCount: employees.filter(e => e.alreadyAccrued).length,
  })
}
