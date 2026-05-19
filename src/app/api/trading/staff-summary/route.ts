import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  numberFromDecimal,
  summaryRange,
  tradingAccountWhereForContext,
} from '@/lib/trading'
import { computeWalletSummary, moneyDecimal } from '@/lib/payroll-wallet'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const accounts = await prisma.tradingAccount.findMany({
    where: tradingAccountWhereForContext(ctx),
    include: { assignedUser: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, salaryHint: true } } },
  })
  const month = summaryRange('month')
  const accountIds = accounts.map(a => a.id)
  const employeeIds = accounts.map(a => a.assignedUser?.employeeIdGas).filter(Boolean) as string[]
  const [tradeGroups, monthlySnapshots, walletGroups] = await Promise.all([
    accountIds.length
      ? prisma.tradingTrade.groupBy({
          by: ['tradingAccountId'],
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
          _sum: { usdtAmount: true },
        })
      : Promise.resolve([]),
    accountIds.length
      ? prisma.tradingDailySnapshot.groupBy({
          by: ['tradingAccountId'],
          where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, date: { gte: month.start, lt: month.end } },
          _sum: { netResultBdt: true },
        })
      : Promise.resolve([]),
    employeeIds.length
      ? prisma.employeeLedgerEntry.groupBy({
          by: ['employeeId', 'type', 'periodYm'],
          where: { businessId: TRADING_BUSINESS_ID, employeeId: { in: employeeIds } },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ])
  const usdtByAccount = new Map(tradeGroups.map(g => [g.tradingAccountId, numberFromDecimal(g._sum.usdtAmount)]))
  const monthNetByAccount = new Map(monthlySnapshots.map(g => [g.tradingAccountId, numberFromDecimal(g._sum.netResultBdt)]))
  const walletByEmployee = new Map<string, ReturnType<typeof computeWalletSummary>>()
  for (const employeeId of new Set(employeeIds)) {
    const rows = walletGroups
      .filter(g => g.employeeId === employeeId)
      .map(g => ({ type: g.type, amount: moneyDecimal(g._sum.amount || 0), periodYm: g.periodYm, date: new Date() }))
    walletByEmployee.set(employeeId, computeWalletSummary(employeeId, TRADING_BUSINESS_ID, rows))
  }
  const byStaff = new Map<string, {
    userId: string
    name: string
    email?: string | null
    assignedAccounts: number
    activeAccounts: number
    totalManagedCapital: number
    totalTradedUsdt: number
    totalAccountProfit: number
    totalAccountLoss: number
    monthlyNetResult: number
    commissionEarned: number
    salaryEarned: number
    withdrawableBalance: number
  }>()

  for (const account of accounts) {
    const key = account.assignedUserId || 'UNASSIGNED'
    const row = byStaff.get(key) ?? {
      userId: key,
      name: account.assignedUser?.name || 'Unassigned',
      email: account.assignedUser?.email,
      assignedAccounts: 0,
      activeAccounts: 0,
      totalManagedCapital: 0,
      totalTradedUsdt: 0,
      totalAccountProfit: 0,
      totalAccountLoss: 0,
      monthlyNetResult: 0,
      commissionEarned: 0,
      salaryEarned: 0,
      withdrawableBalance: 0,
    }
    const wallet = account.assignedUser?.employeeIdGas ? walletByEmployee.get(account.assignedUser.employeeIdGas) : null
    row.assignedAccounts += 1
    if (account.status === 'ACTIVE') row.activeAccounts += 1
    row.totalManagedCapital += numberFromDecimal(account.currentBalance)
    row.totalTradedUsdt += usdtByAccount.get(account.id) || 0
    row.totalAccountProfit += numberFromDecimal(account.totalProfit)
    row.totalAccountLoss += numberFromDecimal(account.totalLoss)
    row.monthlyNetResult += monthNetByAccount.get(account.id) || 0
    row.commissionEarned = wallet?.totalCommissions ?? row.commissionEarned
    row.salaryEarned = wallet?.totalAccrued ?? row.salaryEarned
    row.withdrawableBalance = wallet?.availableWithdrawable ?? row.withdrawableBalance
    byStaff.set(key, row)
  }

  return NextResponse.json({ staff: Array.from(byStaff.values()).sort((a, b) => b.monthlyNetResult - a.monthlyNetResult) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
