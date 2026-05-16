import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, runningTransactions } from '@/lib/payroll-wallet'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const employeeId = url.searchParams.get('employee_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  if (!ctx.isAdmin && (!employeeId || employeeId !== ctx.employeeId)) {
    return forbidden('Employees can only export their own statement.')
  }

  const entries = await prisma.employeeLedgerEntry.findMany({
    where: {
      businessId: { in: ctx.businessIds },
      ...(employeeId ? { employeeId } : {}),
      ...(ctx.isAdmin ? {} : { employeeId: ctx.employeeId }),
    },
    orderBy: [{ employeeId: 'asc' }, { date: 'asc' }, { createdAt: 'asc' }],
  })

  const groups = new Map<string, typeof entries>()
  for (const e of entries) {
    const key = `${e.businessId}:${e.employeeId}`
    groups.set(key, [...(groups.get(key) || []), e])
  }

  const wallets = [...groups.entries()].map(([key, rows]) => {
    const [biz, emp] = key.split(':')
    return {
      employeeId: emp,
      businessId: biz,
      summary: computeWalletSummary(emp, biz, rows),
      transactions: runningTransactions(rows),
    }
  })

  const totals = wallets.reduce(
    (acc, w) => {
      acc.companyLiability += w.summary.companyLiability
      acc.lifetimeEarned += w.summary.lifetimeEarned
      acc.lifetimeWithdrawn += w.summary.lifetimeWithdrawn
      return acc
    },
    { companyLiability: 0, lifetimeEarned: 0, lifetimeWithdrawn: 0 },
  )

  return NextResponse.json({ wallets, totals, generatedAt: new Date().toISOString() })
}
