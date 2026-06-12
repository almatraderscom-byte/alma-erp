import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  getTradingContext,
  getTradingDailySummary,
  numberFromDecimal,
  recalculateTradingAccount,
  summaryRange,
} from '@/lib/trading'

type RouteContext = {
  params: { id: string }
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: {
        id: true,
        businessId: true,
        assignedUserId: true,
        accountTitle: true,
        binanceUid: true,
        accountType: true,
        status: true,
        startingCapital: true,
        currentBalance: true,
        totalProfit: true,
        totalLoss: true,
        totalFees: true,
        totalExpenses: true,
        totalWithdrawals: true,
        netRoi: true,
        totalBuyUsdt: true,
        totalSellUsdt: true,
        totalBuyBdt: true,
        totalSellBdt: true,
        usdtBalance: true,
        inventoryCostBdt: true,
        commissionType: true,
        commissionRate: true,
        fixedCommission: true,
        completionBonus: true,
        merchantTarget: true,
        merchantProgress: true,
        partnershipEnabled: true,
        staffSharePercent: true,
        lastPartnershipSettledAt: true,
        startDate: true,
        completedDate: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        assignedUser: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, salaryHint: true } },
      },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { summary, today } = await prisma.$transaction(async tx => ({
      summary: await recalculateTradingAccount(tx, account.id),
      today: await getTradingDailySummary(tx, account.id),
    }))
    const [recentTrades, recentExpenses, recentCapitalEntries, bkashSummaries, performanceRows, yesterday, last7, currentMonth, timelineTrades, timelineExpenses, timelineCapitalEntries, timelineBkash] = await Promise.all([
      prisma.tradingTrade.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID },
        select: {
          id: true,
          tradeType: true,
          usdtAmount: true,
          bdtRate: true,
          buyRateBdt: true,
          sellRateBdt: true,
          buyAmount: true,
          sellAmount: true,
          feeUsdt: true,
          feeBdt: true,
          feeAmount: true,
          netBdt: true,
          netProfit: true,
          tradeDate: true,
          notes: true,
          deletedAt: true,
          deletedBy: true,
          deleteReason: true,
          deleteApprovedBy: true,
          deleteApprovedAt: true,
          editHistory: true,
          updatedBy: true,
          createdAt: true,
        },
        orderBy: { tradeDate: 'desc' },
        take: 20,
      }),
      prisma.tradingExpense.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, expenseType: true, amount: true, paidBy: true, settlementId: true, notes: true, attachmentUrl: true, expenseDate: true, createdAt: true },
        orderBy: { expenseDate: 'desc' },
        take: 20,
      }),
      prisma.tradingCapitalEntry.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, entryType: true, amount: true, notes: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.tradingBkashDailySummary.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, summaryDate: true, totalOrders: true, totalProfitBdt: true, totalLossBdt: true, netResultBdt: true, notes: true, createdAt: true, creator: { select: { name: true } } },
        orderBy: { summaryDate: 'desc' },
        take: 30,
      }),
      prisma.tradingPerformanceScreenshot.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null, archivedAt: null, shotDate: { gte: recentVisibleCutoff() } },
        select: { id: true, shotDate: true, note: true, originalName: true, contentType: true, sizeBytes: true, expiryDate: true, archivedAt: true, createdAt: true, uploader: { select: { name: true } } },
        orderBy: [{ shotDate: 'desc' }, { createdAt: 'desc' }],
        take: 7,
      }),
      snapshotRange(account.id, 'yesterday'),
      snapshotRange(account.id, 'last7'),
      snapshotRange(account.id, 'month'),
      prisma.tradingTrade.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, tradeType: true, tradeDate: true, buyAmount: true, sellAmount: true, feeBdt: true, feeAmount: true, netProfit: true, usdtAmount: true, netBdt: true },
        orderBy: { tradeDate: 'asc' },
        take: 100,
      }),
      prisma.tradingExpense.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, expenseDate: true, expenseType: true, amount: true },
        orderBy: { expenseDate: 'asc' },
        take: 100,
      }),
      prisma.tradingCapitalEntry.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, createdAt: true, entryType: true, amount: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
      prisma.tradingBkashDailySummary.findMany({
        where: { tradingAccountId: account.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
        select: { id: true, summaryDate: true, totalOrders: true, netResultBdt: true },
        orderBy: { summaryDate: 'asc' },
        take: 100,
      }),
    ])
    const timeline = buildTimeline(Number(account.startingCapital || 0), timelineTrades, timelineExpenses, timelineCapitalEntries, timelineBkash)
    const performanceScreenshots = await Promise.all(performanceRows.map(async shot => ({
      ...shot,
      signedUrl: `/api/trading/screenshots/${encodeURIComponent(shot.id)}/preview`,
    })))

    return NextResponse.json({
      account,
      summary,
      today,
      ranges: {
        today,
        yesterday,
        last7,
        currentMonth,
      },
      balanceDebug: {
        rawCalculatedBalance: summary.currentBalance,
        ledgerTotal: summary.startingCapital + summary.deposits + summary.adjustments - summary.totalWithdrawals,
        expenseTotal: summary.totalExpenses,
        pendingAdjustments: summary.adjustments,
        lastRecalculatedAt: new Date().toISOString(),
      },
      recentTrades,
      recentExpenses,
      recentCapitalEntries,
      bkashSummaries,
      performanceScreenshots,
      timeline,
    }, { headers: { 'Cache-Control': 'private, max-age=5, stale-while-revalidate=20' } })
  } catch (e) {
    logEvent('error', 'trading.summary.failed', { actorUserId: ctx.userId, accountId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

async function snapshotRange(accountId: string, kind: 'yesterday' | 'last7' | 'month') {
  const { start, end } = summaryRange(kind)
  const rows = await prisma.tradingDailySnapshot.findMany({
    where: { tradingAccountId: accountId, businessId: TRADING_BUSINESS_ID, date: { gte: start, lt: end } },
  })
  return {
    tradesCount: rows.reduce((sum, r) => sum + r.tradeCount, 0),
    bkashOrders: 0,
    usdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.usdtVolume), 0),
    buyUsdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.buyUsdtVolume), 0),
    sellUsdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.sellUsdtVolume), 0),
    buyBdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.buyBdtVolume), 0),
    sellBdtVolume: rows.reduce((sum, r) => sum + numberFromDecimal(r.sellBdtVolume), 0),
    profit: rows.reduce((sum, r) => sum + numberFromDecimal(r.grossProfitBdt), 0),
    loss: rows.reduce((sum, r) => sum + numberFromDecimal(r.grossLossBdt), 0),
    bkashProfit: 0,
    bkashLoss: 0,
    fees: rows.reduce((sum, r) => sum + numberFromDecimal(r.feeBdt), 0),
    expenses: rows.reduce((sum, r) => sum + numberFromDecimal(r.expenseBdt), 0),
    netResult: rows.reduce((sum, r) => sum + numberFromDecimal(r.netResultBdt), 0),
  }
}

function recentVisibleCutoff() {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - 6)
  return cutoff
}

function buildTimeline(
  startingCapital: number,
  trades: Array<{ id: string; tradeType: string; tradeDate: Date; buyAmount: unknown; sellAmount: unknown; feeBdt: unknown; feeAmount: unknown; netProfit: unknown; usdtAmount: unknown; netBdt: unknown }>,
  expenses: Array<{ id: string; expenseDate: Date; expenseType: string; amount: unknown }>,
  capitalEntries: Array<{ id: string; createdAt: Date; entryType: string; amount: unknown }>,
  bkashSummaries: Array<{ id: string; summaryDate: Date; totalOrders: number; netResultBdt: unknown }>,
) {
  const events = [
    ...trades.map(t => ({
      id: t.id,
      type: 'TRADE',
      occurredAt: t.tradeDate,
      label: `${t.tradeType} ${numberFromDecimal(t.usdtAmount).toLocaleString('en-BD')} USDT`,
      amount: t.tradeType === 'BUY' ? 0 : numberFromDecimal(t.netProfit),
      profitDelta: numberFromDecimal(t.netProfit),
    })),
    ...expenses.map(e => ({
      id: e.id,
      type: 'EXPENSE',
      occurredAt: e.expenseDate,
      label: e.expenseType,
      amount: -numberFromDecimal(e.amount),
      profitDelta: -numberFromDecimal(e.amount),
    })),
    ...bkashSummaries.map(s => ({
      id: s.id,
      type: 'BKASH_SUMMARY',
      occurredAt: s.summaryDate,
      label: `Bkash summary (${s.totalOrders.toLocaleString('en-BD')} orders)`,
      amount: numberFromDecimal(s.netResultBdt),
      profitDelta: numberFromDecimal(s.netResultBdt),
    })),
    ...capitalEntries.map(c => {
      const amount = numberFromDecimal(c.amount)
      return {
        id: c.id,
        type: c.entryType,
        occurredAt: c.createdAt,
        label: c.entryType,
        amount: c.entryType === 'WITHDRAW' ? -amount : amount,
        profitDelta: 0,
      }
    }),
  ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  let runningBalance = startingCapital
  let runningProfit = 0
  return events.map(e => {
    runningBalance += e.amount
    runningProfit += e.profitDelta
    return {
      ...e,
      occurredAt: e.occurredAt.toISOString(),
      runningBalance,
      runningProfit,
    }
  }).slice(-100).reverse()
}
