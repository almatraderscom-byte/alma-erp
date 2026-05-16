import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, runningTransactions } from '@/lib/payroll-wallet'
import type { HREmployeesApi } from '@/types/hr'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  const businessIds = ctx.isAdmin ? ctx.businessIds : ctx.businessIds.slice(0, 1)
  if (!ctx.isAdmin && !ctx.employeeId) {
    return NextResponse.json({ error: 'No employee profile linked to this account.' }, { status: 400 })
  }

  const where = ctx.isAdmin
    ? { businessId: { in: businessIds } }
    : { businessId: { in: businessIds }, employeeId: ctx.employeeId }

  const [entries, pendingRequests, users] = await Promise.all([
    prisma.employeeLedgerEntry.findMany({ where, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    prisma.walletRequest.findMany({
      where: ctx.isAdmin
        ? { businessId: { in: businessIds }, status: 'PENDING' }
        : { businessId: { in: businessIds }, userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.findMany({
      where: { employeeIdGas: { not: null } },
      select: { id: true, name: true, email: true, employeeIdGas: true, salaryHint: true },
    }),
  ])

  const employeeMeta = new Map<string, { name: string; email?: string; salary?: number }>()
  users.forEach(u => {
    if (u.employeeIdGas) employeeMeta.set(u.employeeIdGas, { name: u.name, email: u.email || undefined, salary: Number(u.salaryHint || 0) })
  })

  if (ctx.isAdmin) {
    await Promise.all(businessIds.map(async biz => {
      try {
        const data = await serverGet<HREmployeesApi>('hr_employees', { business_id: biz }, 0)
        data.employees.forEach(e => {
          employeeMeta.set(e.emp_id, { name: e.name, email: e.email, salary: Number(e.monthly_salary || 0) })
        })
      } catch {
        /* GAS roster unavailable: keep auth-linked metadata. */
      }
    }))
  }

  const groups = new Map<string, typeof entries>()
  for (const e of entries) {
    const key = `${e.businessId}:${e.employeeId}`
    groups.set(key, [...(groups.get(key) || []), e])
  }

  const wallets = [...groups.entries()].map(([key, rows]) => {
    const [biz, employeeId] = key.split(':')
    const meta = employeeMeta.get(employeeId)
    return {
      employeeId,
      businessId: biz,
      name: meta?.name || employeeId,
      email: meta?.email || '',
      monthlySalary: meta?.salary || 0,
      summary: computeWalletSummary(employeeId, biz, rows),
      latestEntries: runningTransactions(rows).slice(-6).reverse(),
    }
  })

  const totals = wallets.reduce(
    (acc, w) => {
      acc.companyLiability += w.summary.companyLiability
      acc.lifetimeEarned += w.summary.lifetimeEarned
      acc.lifetimeWithdrawn += w.summary.lifetimeWithdrawn
      acc.currentBalance += w.summary.currentBalance
      return acc
    },
    { companyLiability: 0, lifetimeEarned: 0, lifetimeWithdrawn: 0, currentBalance: 0 },
  )

  return NextResponse.json({
    wallets,
    totals,
    pendingRequests,
    pendingAdvanceCount: pendingRequests.filter(r => r.type === 'ADVANCE').length,
    pendingWithdrawalCount: pendingRequests.filter(r => r.type === 'WITHDRAWAL').length,
  }, { headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=30' } })
}
