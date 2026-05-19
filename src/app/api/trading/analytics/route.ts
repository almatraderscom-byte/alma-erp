import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  numberFromDecimal,
  summaryRange,
  tradingAccountWhereForContext,
} from '@/lib/trading'

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const url = new URL(req.url)
  const now = new Date()
  const start = parseDate(url.searchParams.get('startDate')) ?? new Date(now.getTime() - 29 * DAY_MS)
  start.setHours(0, 0, 0, 0)
  const end = parseDate(url.searchParams.get('endDate')) ?? now
  end.setHours(23, 59, 59, 999)
  const accountId = url.searchParams.get('accountId') || ''
  const staffId = url.searchParams.get('staffId') || ''
  const status = url.searchParams.get('status') || ''
  const profitability = url.searchParams.get('profitability') || ''
  const minRoi = numberParam(url.searchParams.get('minRoi'))
  const maxRoi = numberParam(url.searchParams.get('maxRoi'))

  const accountWhere = {
    ...tradingAccountWhereForContext(ctx),
    ...(accountId ? { id: accountId } : {}),
    ...(staffId ? { assignedUserId: staffId } : {}),
    ...(status && status !== 'ALL' ? { status: status as never } : {}),
  }

  const accountsRaw = await prisma.tradingAccount.findMany({
    where: accountWhere,
    include: { assignedUser: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, salaryHint: true } } },
    orderBy: { updatedAt: 'desc' },
  })

  const accountIds = accountsRaw.map(a => a.id)
  if (!accountIds.length) {
    return NextResponse.json(emptyAnalytics(start, end), { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const [snapshots, allTradeGroups, expenseGroups, recentTrades, recentExpenses, recentCapitalEntries] = await Promise.all([
    prisma.tradingDailySnapshot.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prisma.tradingTrade.groupBy({
      by: ['tradingAccountId', 'tradeType'],
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
      _sum: { usdtAmount: true, buyAmount: true, sellAmount: true, feeBdt: true, netProfit: true },
      _count: { _all: true },
    }),
    prisma.tradingExpense.groupBy({
      by: ['tradingAccountId', 'expenseType'],
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, expenseDate: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.tradingTrade.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, tradeDate: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { tradingAccount: { select: { accountTitle: true } }, user: { select: { name: true } } },
    }),
    prisma.tradingExpense.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, expenseDate: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { tradingAccount: { select: { accountTitle: true } }, creator: { select: { name: true } } },
    }),
    prisma.tradingCapitalEntry.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { tradingAccount: { select: { accountTitle: true } }, creator: { select: { name: true } } },
    }),
  ])

  const tradeMap = new Map<string, { buy?: (typeof allTradeGroups)[number]; sell?: (typeof allTradeGroups)[number] }>()
  for (const group of allTradeGroups) {
    const row = tradeMap.get(group.tradingAccountId) ?? {}
    if (group.tradeType === 'BUY') row.buy = group
    if (group.tradeType === 'SELL') row.sell = group
    tradeMap.set(group.tradingAccountId, row)
  }
  const expenseByAccount = new Map<string, number>()
  const expenseCategories = new Map<string, number>()
  for (const g of expenseGroups) {
    const amount = numberFromDecimal(g._sum.amount)
    expenseByAccount.set(g.tradingAccountId, (expenseByAccount.get(g.tradingAccountId) || 0) + amount)
    expenseCategories.set(g.expenseType, (expenseCategories.get(g.expenseType) || 0) + amount)
  }

  let accounts = accountsRaw.map(account => {
    const tg = tradeMap.get(account.id)
    const totalBuyUsdt = numberFromDecimal(tg?.buy?._sum.usdtAmount)
    const totalSellUsdt = numberFromDecimal(tg?.sell?._sum.usdtAmount)
    const totalUsdt = totalBuyUsdt + totalSellUsdt
    const totalBuy = numberFromDecimal(tg?.buy?._sum.buyAmount)
    const totalSell = numberFromDecimal(tg?.sell?._sum.sellAmount)
    const netProfit = numberFromDecimal(account.totalProfit) - numberFromDecimal(account.totalLoss) - (expenseByAccount.get(account.id) || 0)
    const roi = numberFromDecimal(account.startingCapital) > 0 ? (netProfit / numberFromDecimal(account.startingCapital)) * 100 : 0
    const feeTotal = numberFromDecimal(account.totalFees)
    const expenseTotal = expenseByAccount.get(account.id) || 0
    const avgBuyRate = totalUsdt > 0 ? totalBuy / totalUsdt : 0
    const avgSellRate = totalUsdt > 0 ? totalSell / totalUsdt : 0
    const averageSpread = avgSellRate - avgBuyRate
    const feeRatio = Math.abs(netProfit) + feeTotal > 0 ? (feeTotal / (Math.abs(netProfit) + feeTotal)) * 100 : 0
    const expenseRatio = Math.abs(netProfit) + expenseTotal > 0 ? (expenseTotal / (Math.abs(netProfit) + expenseTotal)) * 100 : 0
    return {
      id: account.id,
      accountTitle: account.accountTitle,
      assignedUserId: account.assignedUserId,
      assignedUserName: account.assignedUser?.name || 'Unassigned',
      status: account.status,
      currentBalance: numberFromDecimal(account.currentBalance),
      startingCapital: numberFromDecimal(account.startingCapital),
      totalProfit: numberFromDecimal(account.totalProfit),
      totalLoss: numberFromDecimal(account.totalLoss),
      totalFees: feeTotal,
      totalExpenses: expenseTotal,
      totalUsdt,
      totalBuyUsdt,
      totalSellUsdt,
      totalBuyBdt: totalBuy,
      totalSellBdt: totalSell,
      netProfit,
      roi,
      avgBuyRate,
      avgSellRate,
      averageSpread,
      feeRatio,
      expenseRatio,
      merchantProgress: numberFromDecimal(account.merchantProgress),
      health: healthState(numberFromDecimal(account.currentBalance), netProfit, roi, feeRatio, expenseRatio),
    }
  })

  accounts = accounts.filter(a => {
    if (profitability === 'PROFIT' && a.netProfit <= 0) return false
    if (profitability === 'LOSS' && a.netProfit >= 0) return false
    if (minRoi != null && a.roi < minRoi) return false
    if (maxRoi != null && a.roi > maxRoi) return false
    return true
  })

  const accountIdSet = new Set(accounts.map(a => a.id))
  const filteredSnapshots = snapshots.filter(s => accountIdSet.has(s.tradingAccountId))
  const month = summaryRange('month')
  const week = summaryRange('last7')
  const today = summaryRange('today')
  const kpis = {
    totalManagedCapital: accounts.reduce((sum, a) => sum + a.currentBalance, 0),
    todayNet: sumSnapshots(filteredSnapshots, today.start, today.end).netResultBdt,
    weeklyNet: sumSnapshots(filteredSnapshots, week.start, week.end).netResultBdt,
    monthlyNet: sumSnapshots(filteredSnapshots, month.start, month.end).netResultBdt,
    totalUsdtVolume: filteredSnapshots.reduce((sum, s) => sum + numberFromDecimal(s.usdtVolume), 0),
    totalBuyUsdt: filteredSnapshots.reduce((sum, s) => sum + numberFromDecimal(s.buyUsdtVolume), 0),
    totalSellUsdt: filteredSnapshots.reduce((sum, s) => sum + numberFromDecimal(s.sellUsdtVolume), 0),
    totalBinanceFees: filteredSnapshots.reduce((sum, s) => sum + numberFromDecimal(s.feeBdt), 0),
    totalOperatingExpenses: filteredSnapshots.reduce((sum, s) => sum + numberFromDecimal(s.expenseBdt), 0),
    activeMerchantAccounts: accounts.filter(a => a.status === 'ACTIVE').length,
    activeStaffCount: new Set(accounts.filter(a => a.status === 'ACTIVE' && a.assignedUserId).map(a => a.assignedUserId)).size,
  }

  const trend = trendRows(filteredSnapshots)
  const staff = staffRows(accounts, filteredSnapshots)
  const alerts = analyticsAlerts(accounts, filteredSnapshots)

  return NextResponse.json({
    filters: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), accountId, staffId, status, profitability, minRoi, maxRoi },
    kpis,
    topProfitableAccounts: [...accounts].sort((a, b) => b.netProfit - a.netProfit).slice(0, 8),
    topLossAccounts: [...accounts].sort((a, b) => a.netProfit - b.netProfit).slice(0, 8),
    bestSpreadAccounts: [...accounts].sort((a, b) => b.averageSpread - a.averageSpread).slice(0, 8),
    highestExpenseAccounts: [...accounts].sort((a, b) => b.totalExpenses - a.totalExpenses).slice(0, 8),
    staff,
    expenseCategories: Array.from(expenseCategories.entries()).map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount),
    trend,
    alerts,
    recent: { trades: recentTrades, expenses: recentExpenses, capitalEntries: recentCapitalEntries },
    reportRows: accounts,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

function parseDate(value: string | null) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function numberParam(value: string | null) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function healthState(balance: number, netProfit: number, roi: number, feeRatio: number, expenseRatio: number) {
  if (balance < 0 || roi < -5 || netProfit < -10000) return 'HIGH_RISK'
  if (netProfit < 0 || feeRatio > 35 || expenseRatio > 35) return 'MODERATE_RISK'
  if (roi < 1) return 'LOSS_HEAVY'
  return 'HEALTHY'
}

function sumSnapshots(rows: Array<{ date: Date; tradeCount: number; usdtVolume: unknown; grossProfitBdt: unknown; grossLossBdt: unknown; feeBdt: unknown; expenseBdt: unknown; netResultBdt: unknown }>, start: Date, end: Date) {
  const scoped = rows.filter(r => r.date >= start && r.date < end)
  return {
    tradesCount: scoped.reduce((sum, r) => sum + r.tradeCount, 0),
    usdtVolume: scoped.reduce((sum, r) => sum + numberFromDecimal(r.usdtVolume), 0),
    grossProfitBdt: scoped.reduce((sum, r) => sum + numberFromDecimal(r.grossProfitBdt), 0),
    grossLossBdt: scoped.reduce((sum, r) => sum + numberFromDecimal(r.grossLossBdt), 0),
    feeBdt: scoped.reduce((sum, r) => sum + numberFromDecimal(r.feeBdt), 0),
    expenseBdt: scoped.reduce((sum, r) => sum + numberFromDecimal(r.expenseBdt), 0),
    netResultBdt: scoped.reduce((sum, r) => sum + numberFromDecimal(r.netResultBdt), 0),
  }
}

function trendRows(rows: Array<{ date: Date; tradeCount: number; usdtVolume: unknown; buyUsdtVolume: unknown; sellUsdtVolume: unknown; expenseBdt: unknown; netResultBdt: unknown }>) {
  const byDay = new Map<string, { date: string; netBdt: number; usdtVolume: number; buyUsdtVolume: number; sellUsdtVolume: number; expenseBdt: number; tradeCount: number }>()
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10)
    const row = byDay.get(key) ?? { date: key, netBdt: 0, usdtVolume: 0, buyUsdtVolume: 0, sellUsdtVolume: 0, expenseBdt: 0, tradeCount: 0 }
    row.netBdt += numberFromDecimal(r.netResultBdt)
    row.usdtVolume += numberFromDecimal(r.usdtVolume)
    row.buyUsdtVolume += numberFromDecimal(r.buyUsdtVolume)
    row.sellUsdtVolume += numberFromDecimal(r.sellUsdtVolume)
    row.expenseBdt += numberFromDecimal(r.expenseBdt)
    row.tradeCount += r.tradeCount
    byDay.set(key, row)
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-60)
}

function staffRows(accounts: Array<{ assignedUserId: string | null; assignedUserName: string; status: string; currentBalance: number; totalUsdt: number; totalProfit: number; totalLoss: number; totalFees: number; averageSpread: number; roi: number; netProfit: number }>, snapshots: Array<{ tradingAccountId: string; netResultBdt: unknown }>) {
  const byStaff = new Map<string, {
    userId: string
    name: string
    assignedAccounts: number
    activeAccounts: number
    totalManagedCapital: number
    totalTradedUsdt: number
    totalProfitGenerated: number
    totalLossGenerated: number
    feeEfficiency: number
    averageSpread: number
    roiContribution: number
    monthlyNetResult: number
  }>()
  for (const a of accounts) {
    const key = a.assignedUserId || 'UNASSIGNED'
    const row = byStaff.get(key) ?? { userId: key, name: a.assignedUserName, assignedAccounts: 0, activeAccounts: 0, totalManagedCapital: 0, totalTradedUsdt: 0, totalProfitGenerated: 0, totalLossGenerated: 0, feeEfficiency: 0, averageSpread: 0, roiContribution: 0, monthlyNetResult: 0 }
    row.assignedAccounts += 1
    if (a.status === 'ACTIVE') row.activeAccounts += 1
    row.totalManagedCapital += a.currentBalance
    row.totalTradedUsdt += a.totalUsdt
    row.totalProfitGenerated += a.totalProfit
    row.totalLossGenerated += a.totalLoss
    row.feeEfficiency += a.totalProfit + a.totalFees > 0 ? (a.totalProfit / (a.totalProfit + a.totalFees)) * 100 : 0
    row.averageSpread += a.averageSpread
    row.roiContribution += a.roi
    row.monthlyNetResult += a.netProfit
    byStaff.set(key, row)
  }
  return Array.from(byStaff.values()).map(r => ({
    ...r,
    feeEfficiency: r.assignedAccounts ? r.feeEfficiency / r.assignedAccounts : 0,
    averageSpread: r.assignedAccounts ? r.averageSpread / r.assignedAccounts : 0,
    roiContribution: r.assignedAccounts ? r.roiContribution / r.assignedAccounts : 0,
  })).sort((a, b) => b.monthlyNetResult - a.monthlyNetResult)
}

function analyticsAlerts(accounts: Array<{ id: string; accountTitle: string; currentBalance: number; netProfit: number; totalFees: number; totalExpenses: number; feeRatio: number; expenseRatio: number; status: string; health: string }>, snapshots: Array<{ tradingAccountId: string; date: Date; netResultBdt: unknown; feeBdt: unknown; expenseBdt: unknown }>) {
  const alerts: Array<{ severity: 'HIGH' | 'NORMAL'; type: string; accountId: string; accountTitle: string; message: string }> = []
  for (const a of accounts) {
    if (a.currentBalance < 0) alerts.push({ severity: 'HIGH', type: 'NEGATIVE_BALANCE', accountId: a.id, accountTitle: a.accountTitle, message: 'Account balance is negative.' })
    if (a.netProfit < -10000) alerts.push({ severity: 'HIGH', type: 'ABNORMAL_LOSS', accountId: a.id, accountTitle: a.accountTitle, message: 'Account has abnormal losses in the selected period.' })
    if (a.feeRatio > 35) alerts.push({ severity: 'NORMAL', type: 'FEE_SPIKE', accountId: a.id, accountTitle: a.accountTitle, message: 'Binance fees are unusually high versus profit.' })
    if (a.expenseRatio > 35) alerts.push({ severity: 'NORMAL', type: 'EXCESSIVE_EXPENSE', accountId: a.id, accountTitle: a.accountTitle, message: 'Operating expenses are unusually high.' })
    if (a.status === 'ACTIVE' && !snapshots.some(s => s.tradingAccountId === a.id)) alerts.push({ severity: 'NORMAL', type: 'INACTIVE_MERCHANT', accountId: a.id, accountTitle: a.accountTitle, message: 'No snapshot activity in selected period.' })
  }
  return alerts.slice(0, 30)
}

function emptyAnalytics(start: Date, end: Date) {
  return {
    filters: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
    kpis: { totalManagedCapital: 0, todayNet: 0, weeklyNet: 0, monthlyNet: 0, totalUsdtVolume: 0, totalBinanceFees: 0, totalOperatingExpenses: 0, activeMerchantAccounts: 0, activeStaffCount: 0 },
    topProfitableAccounts: [],
    topLossAccounts: [],
    bestSpreadAccounts: [],
    highestExpenseAccounts: [],
    staff: [],
    expenseCategories: [],
    trend: [],
    alerts: [],
    recent: { trades: [], expenses: [], capitalEntries: [] },
    reportRows: [],
  }
}
