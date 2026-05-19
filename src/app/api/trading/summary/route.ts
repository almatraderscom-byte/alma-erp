import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  numberFromDecimal,
  summaryRange,
  tradingAccountWhereForContext,
} from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const accounts = await prisma.tradingAccount.findMany({
    where: tradingAccountWhereForContext(ctx),
    select: {
      id: true,
      status: true,
      currentBalance: true,
      totalProfit: true,
      totalLoss: true,
      totalFees: true,
      totalBuyUsdt: true,
      totalSellUsdt: true,
    },
  })
  const accountIds = accounts.map(a => a.id)
  if (!accountIds.length) {
    return NextResponse.json(emptySummary(), { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const month = summaryRange('month')
  const tradeAgg = await prisma.tradingTrade.aggregate({
    where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
    _sum: { usdtAmount: true },
  })
  const expenseAgg = await prisma.tradingExpense.aggregate({
    where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
    _sum: { amount: true },
  })
  const today = await snapshotRange(accountIds, 'today')
  const yesterday = await snapshotRange(accountIds, 'yesterday')
  const last7 = await snapshotRange(accountIds, 'last7')
  const currentMonth = await snapshotRange(accountIds, 'month')

  const totalCapital = accounts.reduce((sum, a) => sum + numberFromDecimal(a.currentBalance), 0)
  const totalProfit = accounts.reduce((sum, a) => sum + numberFromDecimal(a.totalProfit), 0)
  const totalLoss = accounts.reduce((sum, a) => sum + numberFromDecimal(a.totalLoss), 0)
  const totalFees = accounts.reduce((sum, a) => sum + numberFromDecimal(a.totalFees), 0)

  return NextResponse.json({
    kpis: {
      activeAccounts: accounts.filter(a => a.status === 'ACTIVE').length,
      totalCapital,
      totalProfit,
      totalLoss,
      totalFees,
      totalOperatingExpenses: numberFromDecimal(expenseAgg._sum.amount),
      dailyNetBdt: today.netResultBdt,
      monthlyNetBdt: currentMonth.netResultBdt,
      totalTradedUsdt: numberFromDecimal(tradeAgg._sum.usdtAmount),
      totalBuyUsdt: accounts.reduce((sum, a) => sum + numberFromDecimal(a.totalBuyUsdt), 0),
      totalSellUsdt: accounts.reduce((sum, a) => sum + numberFromDecimal(a.totalSellUsdt), 0),
      currentMonthStart: month.start.toISOString(),
    },
    ranges: { today, yesterday, last7, currentMonth },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

async function snapshotRange(accountIds: string[], kind: 'today' | 'yesterday' | 'last7' | 'month') {
  const { start, end } = summaryRange(kind)
  const rows = await prisma.tradingDailySnapshot.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      tradingAccountId: { in: accountIds },
      date: { gte: start, lt: end },
    },
    select: {
      tradeCount: true,
      usdtVolume: true,
      buyUsdtVolume: true,
      sellUsdtVolume: true,
      buyBdtVolume: true,
      sellBdtVolume: true,
      grossProfitBdt: true,
      grossLossBdt: true,
      feeBdt: true,
      expenseBdt: true,
      netResultBdt: true,
    },
  })
  return {
    tradesCount: rows.reduce((sum, r) => sum + r.tradeCount, 0),
    usdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.usdtVolume), 0),
    buyUsdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.buyUsdtVolume), 0),
    sellUsdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.sellUsdtVolume), 0),
    buyBdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.buyBdtVolume), 0),
    sellBdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.sellBdtVolume), 0),
    grossProfitBdt: rows.reduce((sum, r) => sum + numberFromDecimal(r.grossProfitBdt), 0),
    grossLossBdt: rows.reduce((sum, r) => sum + numberFromDecimal(r.grossLossBdt), 0),
    feeBdt: rows.reduce((sum, r) => sum + numberFromDecimal(r.feeBdt), 0),
    expenseBdt: rows.reduce((sum, r) => sum + numberFromDecimal(r.expenseBdt), 0),
    netResultBdt: rows.reduce((sum, r) => sum + numberFromDecimal(r.netResultBdt), 0),
  }
}

function emptySummary() {
  const emptyRange = { tradesCount: 0, usdtVolume: 0, buyUsdtVolume: 0, sellUsdtVolume: 0, buyBdtVolume: 0, sellBdtVolume: 0, grossProfitBdt: 0, grossLossBdt: 0, feeBdt: 0, expenseBdt: 0, netResultBdt: 0 }
  return {
    kpis: {
      activeAccounts: 0,
      totalCapital: 0,
      totalProfit: 0,
      totalLoss: 0,
      totalFees: 0,
      totalOperatingExpenses: 0,
      dailyNetBdt: 0,
      monthlyNetBdt: 0,
      totalTradedUsdt: 0,
      totalBuyUsdt: 0,
      totalSellUsdt: 0,
      currentMonthStart: summaryRange('month').start.toISOString(),
    },
    ranges: { today: emptyRange, yesterday: emptyRange, last7: emptyRange, currentMonth: emptyRange },
  }
}
