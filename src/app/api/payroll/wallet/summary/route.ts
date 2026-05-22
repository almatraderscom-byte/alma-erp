import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, moneyDecimal, runningTransactions } from '@/lib/payroll-wallet'
import type { HREmployeesApi } from '@/types/hr'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const rosterOnly =
    url.searchParams.get('roster_only') === 'true' || url.searchParams.get('rosterOnly') === 'true'
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  const businessIds = ctx.isAdmin ? ctx.businessIds : ctx.businessIds.slice(0, 1)
  if (!ctx.isAdmin && !ctx.employeeId) {
    return NextResponse.json({ error: 'No employee profile linked to this account.' }, { status: 400 })
  }

  const where = ctx.isAdmin
    ? { businessId: { in: businessIds }, isArchived: false }
    : { businessId: { in: businessIds }, employeeId: ctx.employeeId, isArchived: false }

  const [entryGroups, recentEntries, pendingRequests, users] = await Promise.all([
    prisma.employeeLedgerEntry.groupBy({
      by: ['businessId', 'employeeId', 'type', 'periodYm'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.employeeLedgerEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: ctx.isAdmin ? 1200 : 200,
      select: { id: true, employeeId: true, businessId: true, date: true, periodYm: true, type: true, amount: true, note: true, source: true, createdAt: true },
    }),
    prisma.walletRequest.findMany({
      where: ctx.isAdmin
        ? { businessId: { in: businessIds }, status: 'PENDING' }
        : { businessId: { in: businessIds }, userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        employeeId: true,
        businessId: true,
        type: true,
        status: true,
        requestedAmount: true,
        approvedAmount: true,
        reason: true,
        reviewNote: true,
        createdAt: true,
        reviewedAt: true,
      },
    }),
    prisma.user.findMany({
      where: {
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
        OR: businessIds.map(biz => ({ businessAccess: { contains: biz } })),
      },
      select: { id: true, name: true, email: true, employeeIdGas: true, salaryHint: true },
    }),
  ])

  const employeeMeta = new Map<string, { name: string; email?: string; salary?: number }>()
  const knownEmployeeKeys = new Set<string>()
  const rosterEmployeeIdsByBiz = new Map<string, Set<string>>()
  const linkedEmployeeIds = new Set<string>()
  users.forEach(u => {
    if (u.employeeIdGas) {
      linkedEmployeeIds.add(u.employeeIdGas)
      employeeMeta.set(u.employeeIdGas, { name: u.name, email: u.email || undefined, salary: Number(u.salaryHint || 0) })
      businessIds.forEach(biz => knownEmployeeKeys.add(`${biz}:${u.employeeIdGas}`))
    }
  })

  if (ctx.isAdmin) {
    await Promise.all(businessIds.map(async biz => {
      try {
        const data = await serverGet<HREmployeesApi>('hr_employees', { business_id: biz }, 0)
        const rosterSet = new Set(data.employees.map(e => e.emp_id))
        rosterEmployeeIdsByBiz.set(biz, rosterSet)
        data.employees.forEach(e => {
          employeeMeta.set(e.emp_id, { name: e.name, email: e.email, salary: Number(e.monthly_salary || 0) })
          knownEmployeeKeys.add(`${biz}:${e.emp_id}`)
        })
      } catch {
        /* GAS roster unavailable: keep auth-linked metadata. */
      }
    }))
  }

  const isOperationalEmployee = (biz: string, employeeId: string) => {
    const inRoster = rosterEmployeeIdsByBiz.get(biz)?.has(employeeId) ?? false
    return inRoster || linkedEmployeeIds.has(employeeId)
  }

  const groups = new Map<string, Array<{ type: typeof entryGroups[number]['type']; amount: ReturnType<typeof moneyDecimal>; periodYm: string | null; date: Date }>>()
  const entryCounts = new Map<string, number>()
  for (const e of entryGroups) {
    const key = `${e.businessId}:${e.employeeId}`
    groups.set(key, [
      ...(groups.get(key) || []),
      {
        type: e.type,
        amount: moneyDecimal(e._sum.amount || 0),
        periodYm: e.periodYm,
        date: new Date(),
      },
    ])
    entryCounts.set(key, (entryCounts.get(key) || 0) + e._count._all)
    knownEmployeeKeys.add(key)
  }

  const latestByKey = new Map<string, typeof recentEntries>()
  for (const entry of recentEntries) {
    const key = `${entry.businessId}:${entry.employeeId}`
    const rows = latestByKey.get(key) || []
    if (rows.length < 6) latestByKey.set(key, [...rows, entry])
    knownEmployeeKeys.add(key)
  }

  const allKeys = [...knownEmployeeKeys].sort()
  const operationalKeys = rosterOnly
    ? allKeys.filter(key => {
        const [biz, employeeId] = key.split(':')
        return isOperationalEmployee(biz, employeeId)
      })
    : allKeys
  const orphanLedgerEntryCount = allKeys.filter(key => {
    const [biz, employeeId] = key.split(':')
    return !isOperationalEmployee(biz, employeeId)
  }).length

  const wallets = operationalKeys.map(key => {
    const [biz, employeeId] = key.split(':')
    const rows = groups.get(key) || []
    const meta = employeeMeta.get(employeeId)
    const summary = computeWalletSummary(employeeId, biz, rows)
    summary.entryCount = entryCounts.get(key) || 0
    return {
      employeeId,
      businessId: biz,
      name: meta?.name || employeeId,
      email: meta?.email || '',
      monthlySalary: meta?.salary || 0,
      summary,
      latestEntries: runningTransactions([...(latestByKey.get(key) || [])].reverse()).reverse(),
    }
  })

  const totals = wallets.reduce(
    (acc, w) => {
      acc.companyLiability += w.summary.companyLiability
      acc.lifetimeEarned += w.summary.lifetimeEarned
      acc.lifetimeWithdrawn += w.summary.lifetimeWithdrawn
      acc.currentBalance += w.summary.currentBalance
      acc.totalAccrued += w.summary.totalAccrued
      acc.totalCommissions += w.summary.totalCommissions
      acc.totalBonuses += w.summary.totalBonuses
      acc.totalOvertime += w.summary.totalOvertime
      acc.totalReimbursements += w.summary.totalReimbursements
      acc.totalMealDeductions += w.summary.totalMealDeductions
      acc.totalPenalties += w.summary.totalPenalties
      return acc
    },
    {
      companyLiability: 0,
      lifetimeEarned: 0,
      lifetimeWithdrawn: 0,
      currentBalance: 0,
      totalAccrued: 0,
      totalCommissions: 0,
      totalBonuses: 0,
      totalOvertime: 0,
      totalReimbursements: 0,
      totalMealDeductions: 0,
      totalPenalties: 0,
    },
  )

  return NextResponse.json({
    wallets,
    totals,
    pendingRequests,
    pendingAdvanceCount: pendingRequests.filter(r => r.type === 'ADVANCE').length,
    pendingWithdrawalCount: pendingRequests.filter(r => r.type === 'WITHDRAWAL').length,
    orphanLedgerEntryCount,
    rosterOnly,
  }, { headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=30' } })
}
