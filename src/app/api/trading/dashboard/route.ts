import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  numberFromDecimal,
  summaryRange,
  todayRange,
  tradingAccountWhereForContext,
} from '@/lib/trading'
import { createNotification } from '@/lib/notifications'
import { assessTradingAccountOps, type TradingAlertSeverity } from '@/lib/trading-ops-engine'
import {
  isPastScreenshotCutoff,
  screenshotComplianceStatus,
  screenshotUploadedToday,
  tradingScreenshotCutoffHour,
} from '@/lib/trading-compliance'

const ALERT_PRIORITY: Record<TradingAlertSeverity, 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'> = {
  LOW: 'LOW',
  MEDIUM: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
}

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const { start, end } = todayRange()
  const accountWhere = tradingAccountWhereForContext(ctx)
  const accounts = await prisma.tradingAccount.findMany({
    where: accountWhere,
    select: {
      id: true,
      assignedUserId: true,
      accountTitle: true,
      status: true,
      currentBalance: true,
      startingCapital: true,
      totalProfit: true,
      totalLoss: true,
      totalFees: true,
      totalExpenses: true,
      totalBuyBdt: true,
      totalSellBdt: true,
      totalBuyUsdt: true,
      totalSellUsdt: true,
      netRoi: true,
      merchantProgress: true,
      updatedAt: true,
      usdtBalance: true,
      assignedUser: { select: { id: true, name: true, email: true, employeeIdGas: true } },
    },
  })
  const accountIds = accounts.map(a => a.id)

  if (!accountIds.length) {
    return NextResponse.json({
      kpis: {
        activeAccounts: 0,
        todayTradeCount: 0,
        todayProfit: 0,
        todayLoss: 0,
        todayFees: 0,
        todayBuyUsdt: 0,
        todaySellUsdt: 0,
        todayBuyBdt: 0,
        todaySellBdt: 0,
        netTodayResult: 0,
        totalCapital: 0,
        currentBalance: 0,
        totalExpenses: 0,
        totalTradeVolume: 0,
        totalUsdtVolume: 0,
        activeStaffCount: 0,
      },
      accountPerformance: [],
      alerts: [],
      merchantGrowth: { averageScore: 0, trend: 'FLAT', weeklyComparison: 0 },
      capitalRisk: { remainingCapital: 0, capitalUtilization: 0, lossExposure: 0, feeBurden: 0 },
      staffRankings: { topPerformer: null, lowestPerformer: null, rows: [] },
      trend: [],
      latestTrades: [],
      latestExpenses: [],
      latestCapitalEntries: [],
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const last14 = summaryRange('today')
  last14.start.setDate(last14.start.getDate() - 13)
  const week = summaryRange('last7')
  const previousWeekStart = new Date(week.start)
  previousWeekStart.setDate(previousWeekStart.getDate() - 7)
  const previousWeekEnd = new Date(week.start)
  const [
    todayBkashSummaries,
    snapshots,
    screenshotGroups,
    commissionGroups,
    latestTrades,
    latestExpenses,
    latestCapitalEntries,
  ] = await Promise.all([
    prisma.tradingBkashDailySummary.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null, summaryDate: { gte: start, lt: end } },
      select: { totalOrders: true, totalProfitBdt: true, totalLossBdt: true },
    }),
    prisma.tradingDailySnapshot.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, date: { gte: last14.start, lt: last14.end } },
      orderBy: { date: 'asc' },
    }),
    prisma.tradingPerformanceScreenshot.groupBy({
      by: ['tradingAccountId'],
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
      _count: { _all: true },
      _max: { shotDate: true },
    }),
    prisma.employeeLedgerEntry.groupBy({
      by: ['employeeId'],
      where: { businessId: TRADING_BUSINESS_ID, type: { in: ['COMMISSION', 'PERFORMANCE_BONUS'] } },
      _sum: { amount: true },
    }),
    prisma.tradingTrade.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, tradingAccountId: true, tradeType: true, usdtAmount: true, feeBdt: true, feeAmount: true, netProfit: true, tradingAccount: { select: { accountTitle: true } }, user: { select: { name: true } } },
    }),
    prisma.tradingExpense.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, tradingAccountId: true, expenseType: true, amount: true, tradingAccount: { select: { accountTitle: true } }, creator: { select: { name: true } } },
    }),
    prisma.tradingCapitalEntry.findMany({
      where: { businessId: TRADING_BUSINESS_ID, tradingAccountId: { in: accountIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, tradingAccountId: true, entryType: true, amount: true, tradingAccount: { select: { accountTitle: true } }, creator: { select: { name: true } } },
    }),
  ])

  const todaySnapshotTotal = sumSnapshots(snapshots.filter(row => row.date >= start && row.date < end))
  const todayProfit = todaySnapshotTotal.grossProfitBdt
  const todayLoss = todaySnapshotTotal.grossLossBdt
  const todayFees = todaySnapshotTotal.feeBdt
  const todayBkashOrders = todayBkashSummaries.reduce((sum, row) => sum + row.totalOrders, 0)
  const todayBkashProfit = todayBkashSummaries.reduce((sum, row) => sum + numberFromDecimal(row.totalProfitBdt), 0)
  const todayBkashLoss = todayBkashSummaries.reduce((sum, row) => sum + numberFromDecimal(row.totalLossBdt), 0)
  const todayExpenseTotal = todaySnapshotTotal.expenseBdt
  const activeStaffCount = new Set(accounts.filter(a => a.status === 'ACTIVE' && a.assignedUserId).map(a => a.assignedUserId)).size
  const snapshotsByAccount = groupBy(snapshots, row => row.tradingAccountId)
  const screenshotsByAccount = new Map(screenshotGroups.map(row => [row.tradingAccountId, row]))
  const commissionByEmployee = new Map(commissionGroups.map(row => [row.employeeId, numberFromDecimal(row._sum.amount)]))
  const accountPerformance = accounts.map(account => {
    const accountSnapshots = snapshotsByAccount.get(account.id) ?? []
    const todaySnapshot = sumSnapshots(accountSnapshots.filter(row => row.date >= start && row.date < end))
    const weeklySnapshot = sumSnapshots(accountSnapshots.filter(row => row.date >= week.start && row.date < week.end))
    const previousWeekSnapshot = sumSnapshots(accountSnapshots.filter(row => row.date >= previousWeekStart && row.date < previousWeekEnd))
    const lastActivity = [...accountSnapshots].reverse().find(row => row.tradeCount > 0 || numberFromDecimal(row.netResultBdt) !== 0)?.date ?? account.updatedAt
    const screenshotGroup = screenshotsByAccount.get(account.id)
    const assessment = assessTradingAccountOps({
      accountId: account.id,
      accountTitle: account.accountTitle,
      currentBalance: numberFromDecimal(account.currentBalance),
      startingCapital: numberFromDecimal(account.startingCapital),
      totalProfit: numberFromDecimal(account.totalProfit),
      totalLoss: numberFromDecimal(account.totalLoss),
      totalFees: numberFromDecimal(account.totalFees),
      totalExpenses: numberFromDecimal(account.totalExpenses),
      merchantProgress: numberFromDecimal(account.merchantProgress),
      snapshots: accountSnapshots.map(row => ({
        date: row.date,
        tradeCount: row.tradeCount,
        netResultBdt: numberFromDecimal(row.netResultBdt),
        grossProfitBdt: numberFromDecimal(row.grossProfitBdt),
        grossLossBdt: numberFromDecimal(row.grossLossBdt),
        feeBdt: numberFromDecimal(row.feeBdt),
        expenseBdt: numberFromDecimal(row.expenseBdt),
      })),
      lastActivityAt: lastActivity,
      lastScreenshotAt: screenshotGroup?._max.shotDate ?? null,
    })
    const totalProfit = numberFromDecimal(account.totalProfit)
    const totalLoss = numberFromDecimal(account.totalLoss)
    const totalExpenses = numberFromDecimal(account.totalExpenses)
    const totalTradeVolume = numberFromDecimal(account.totalBuyBdt) + numberFromDecimal(account.totalSellBdt)
    return {
      id: account.id,
      accountTitle: account.accountTitle,
      status: account.status,
      assignedStaff: account.assignedUser?.name || 'Unassigned',
      assignedUserId: account.assignedUserId,
      currentBalance: numberFromDecimal(account.currentBalance),
      startingCapital: numberFromDecimal(account.startingCapital),
      dailyPl: todaySnapshot.netResultBdt,
      weeklyPl: weeklySnapshot.netResultBdt,
      previousWeeklyPl: previousWeekSnapshot.netResultBdt,
      roi: numberFromDecimal(account.netRoi),
      expenseRatio: assessment.expenseRatio,
      feeTotals: numberFromDecimal(account.totalFees),
      merchantProgress: numberFromDecimal(account.merchantProgress),
      activityStatus: assessment.activityStatus,
      health: assessment.health,
      merchantGrowthScore: assessment.merchantGrowthScore,
      merchantGrowthTrend: assessment.merchantGrowthTrend,
      capitalUtilization: assessment.capitalUtilization,
      lossExposure: assessment.lossExposure,
      feeBurden: assessment.feeBurden,
      inactiveDays: assessment.inactiveDays,
      lossStreak: assessment.lossStreak,
      totalProfit,
      totalLoss,
      totalExpenses,
      totalTradeVolume,
      totalUsdtVolume: numberFromDecimal(account.totalBuyUsdt) + numberFromDecimal(account.totalSellUsdt),
      lastScreenshotAt: screenshotGroup?._max.shotDate?.toISOString() ?? null,
      screenshotCount: screenshotGroup?._count._all ?? 0,
      screenshotToday: screenshotUploadedToday(screenshotGroup?._max.shotDate ?? null),
      screenshotCompliance: screenshotComplianceStatus(screenshotGroup?._max.shotDate ?? null),
      balanceDebug: {
        rawCalculatedBalance: numberFromDecimal(account.currentBalance),
        ledgerTotal: numberFromDecimal(account.startingCapital),
        expenseTotal: totalExpenses,
        pendingAdjustments: 0,
        lastRecalculatedAt: account.updatedAt.toISOString(),
      },
      alerts: assessment.alerts,
    }
  }).sort((a, b) => {
    const order = { LOSS: 0, RISK: 1, STABLE: 2, PROFITABLE: 3 }
    return order[a.health] - order[b.health] || a.weeklyPl - b.weeklyPl
  })
  const alerts = accountPerformance.flatMap(account => account.alerts.map(alert => ({
    ...alert,
    accountId: account.id,
    accountTitle: account.accountTitle,
    actionUrl: `/trading/accounts/${account.id}`,
  }))).sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity)).slice(0, 20)
  void persistOwnerAlerts(alerts.slice(0, 8), new Set(alerts.map(alert => alert.key))).catch(() => {})
  const trend = trendRows(snapshots)
  const staffRows = buildStaffRankings(accountPerformance, commissionByEmployee, accounts)
  const totalCapital = accounts.reduce((sum, account) => sum + numberFromDecimal(account.startingCapital), 0)
  const currentBalance = accounts.reduce((sum, account) => sum + numberFromDecimal(account.currentBalance), 0)
  const totalTradeVolume = accounts.reduce((sum, account) => sum + numberFromDecimal(account.totalBuyBdt) + numberFromDecimal(account.totalSellBdt), 0)
  const totalUsdtVolume = accounts.reduce((sum, account) => sum + numberFromDecimal(account.totalBuyUsdt) + numberFromDecimal(account.totalSellUsdt), 0)
  const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

  return NextResponse.json({
    kpis: {
      activeAccounts: accounts.filter(a => a.status === 'ACTIVE').length,
      todayTradeCount: todaySnapshotTotal.tradesCount + todayBkashOrders,
      todayProfit: todayProfit + todayBkashProfit,
      todayLoss: todayLoss + todayBkashLoss,
      todayFees,
      todayBuyUsdt: todaySnapshotTotal.buyUsdtVolume,
      todaySellUsdt: todaySnapshotTotal.sellUsdtVolume,
      todayBuyBdt: todaySnapshotTotal.buyBdtVolume,
      todaySellBdt: todaySnapshotTotal.sellBdtVolume,
      netTodayResult: todayProfit + todayBkashProfit - todayLoss - todayBkashLoss - todayExpenseTotal,
      totalCapital,
      currentBalance,
      totalExpenses: accounts.reduce((sum, account) => sum + numberFromDecimal(account.totalExpenses), 0),
      totalTradeVolume,
      totalUsdtVolume,
      activeStaffCount,
    },
    accountPerformance,
    alerts,
    screenshotCompliance: {
      cutoffHourBd: tradingScreenshotCutoffHour(),
      pastCutoff: isPastScreenshotCutoff(),
      completeCount: accountPerformance.filter(a => a.screenshotCompliance === 'COMPLETE').length,
      dueCount: accountPerformance.filter(a => a.screenshotCompliance === 'DUE').length,
      overdueCount: accountPerformance.filter(a => a.screenshotCompliance === 'OVERDUE').length,
    },
    merchantGrowth: {
      averageScore: avg(accountPerformance.map(account => account.merchantGrowthScore)),
      trend: trend.length >= 2 && trend.at(-1)!.netBdt > trend.at(-2)!.netBdt ? 'UP' : trend.length >= 2 && trend.at(-1)!.netBdt < trend.at(-2)!.netBdt ? 'DOWN' : 'FLAT',
      weeklyComparison: accountPerformance.reduce((sum, account) => sum + account.weeklyPl - account.previousWeeklyPl, 0),
    },
    capitalRisk: {
      remainingCapital: currentBalance,
      capitalUtilization: avg(accountPerformance.map(account => account.capitalUtilization)),
      lossExposure: avg(accountPerformance.map(account => account.lossExposure)),
      feeBurden: avg(accountPerformance.map(account => account.feeBurden)),
    },
    staffRankings: {
      topPerformer: staffRows[0] ?? null,
      lowestPerformer: staffRows.length ? staffRows[staffRows.length - 1] : null,
      rows: staffRows,
    },
    trend,
    latestTrades,
    latestExpenses,
    latestCapitalEntries,
  }, { headers: { 'Cache-Control': 'private, max-age=5, stale-while-revalidate=20' } })
}

function sumSnapshots(rows: Array<{ tradeCount: number; usdtVolume: unknown; buyUsdtVolume: unknown; sellUsdtVolume: unknown; buyBdtVolume: unknown; sellBdtVolume: unknown; grossProfitBdt: unknown; grossLossBdt: unknown; feeBdt: unknown; expenseBdt: unknown; netResultBdt: unknown }>) {
  return {
    tradesCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
    usdtVolume: rows.reduce((sum, row) => sum + numberFromDecimal(row.usdtVolume), 0),
    buyUsdtVolume: rows.reduce((sum, row) => sum + numberFromDecimal(row.buyUsdtVolume), 0),
    sellUsdtVolume: rows.reduce((sum, row) => sum + numberFromDecimal(row.sellUsdtVolume), 0),
    buyBdtVolume: rows.reduce((sum, row) => sum + numberFromDecimal(row.buyBdtVolume), 0),
    sellBdtVolume: rows.reduce((sum, row) => sum + numberFromDecimal(row.sellBdtVolume), 0),
    grossProfitBdt: rows.reduce((sum, row) => sum + numberFromDecimal(row.grossProfitBdt), 0),
    grossLossBdt: rows.reduce((sum, row) => sum + numberFromDecimal(row.grossLossBdt), 0),
    feeBdt: rows.reduce((sum, row) => sum + numberFromDecimal(row.feeBdt), 0),
    expenseBdt: rows.reduce((sum, row) => sum + numberFromDecimal(row.expenseBdt), 0),
    netResultBdt: rows.reduce((sum, row) => sum + numberFromDecimal(row.netResultBdt), 0),
  }
}

function trendRows(rows: Array<{ date: Date; tradeCount: number; usdtVolume: unknown; netResultBdt: unknown; grossProfitBdt: unknown; grossLossBdt: unknown }>) {
  const byDay = new Map<string, { date: string; netBdt: number; profit: number; loss: number; usdtVolume: number; tradeCount: number }>()
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10)
    const existing = byDay.get(key) ?? { date: key, netBdt: 0, profit: 0, loss: 0, usdtVolume: 0, tradeCount: 0 }
    existing.netBdt += numberFromDecimal(row.netResultBdt)
    existing.profit += numberFromDecimal(row.grossProfitBdt)
    existing.loss += numberFromDecimal(row.grossLossBdt)
    existing.usdtVolume += numberFromDecimal(row.usdtVolume)
    existing.tradeCount += row.tradeCount
    byDay.set(key, existing)
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date))
}

function buildStaffRankings(
  accounts: Array<{ assignedUserId: string | null; assignedStaff: string; currentBalance: number; totalProfit: number; totalLoss: number; totalExpenses: number; totalTradeVolume: number; merchantGrowthScore: number; activityStatus: string; weeklyPl: number; expenseRatio: number }>,
  commissionByEmployee: Map<string, number>,
  rawAccounts: Array<{ assignedUserId: string | null; assignedUser?: { employeeIdGas: string | null } | null }>,
) {
  const employeeByUser = new Map(rawAccounts.map(account => [account.assignedUserId || 'UNASSIGNED', account.assignedUser?.employeeIdGas || '']))
  const byStaff = new Map<string, { userId: string; name: string; managedAccounts: number; totalProfitGenerated: number; managedCapital: number; activityConsistency: number; expenseEfficiency: number; commissionEarned: number; score: number }>()
  for (const account of accounts) {
    const key = account.assignedUserId || 'UNASSIGNED'
    const row = byStaff.get(key) ?? { userId: key, name: account.assignedStaff, managedAccounts: 0, totalProfitGenerated: 0, managedCapital: 0, activityConsistency: 0, expenseEfficiency: 0, commissionEarned: 0, score: 0 }
    row.managedAccounts += 1
    row.totalProfitGenerated += account.totalProfit - account.totalLoss - account.totalExpenses
    row.managedCapital += account.currentBalance
    row.activityConsistency += account.activityStatus === 'ACTIVE_TODAY' ? 1 : account.activityStatus === 'ACTIVE_RECENTLY' ? 0.5 : 0
    row.expenseEfficiency += Math.max(0, 100 - account.expenseRatio)
    row.commissionEarned = commissionByEmployee.get(employeeByUser.get(key) || '') || 0
    byStaff.set(key, row)
  }
  return Array.from(byStaff.values()).map(row => ({
    ...row,
    activityConsistency: row.managedAccounts ? (row.activityConsistency / row.managedAccounts) * 100 : 0,
    expenseEfficiency: row.managedAccounts ? row.expenseEfficiency / row.managedAccounts : 0,
    score: row.totalProfitGenerated + row.activityConsistency * 100 + row.expenseEfficiency * 50,
  })).sort((a, b) => b.score - a.score)
}

async function persistOwnerAlerts(alerts: Array<{ key: string; severity: TradingAlertSeverity; title: string; message: string; actionUrl: string }>, activeKeys: Set<string>) {
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000)
  await dismissStaleTradingAlerts(activeKeys)
  for (const alert of alerts) {
    const exists = await prisma.notification.findFirst({
      where: { businessId: TRADING_BUSINESS_ID, type: 'ADMIN_ANNOUNCEMENT', title: alert.title, actionUrl: alert.actionUrl, createdAt: { gte: cutoff } },
      select: { id: true },
    })
    if (exists) continue
    await createNotification({
      role: 'SUPER_ADMIN',
      businessId: TRADING_BUSINESS_ID,
      type: 'ADMIN_ANNOUNCEMENT',
      priority: ALERT_PRIORITY[alert.severity],
      title: alert.title,
      message: alert.message,
      actionUrl: alert.actionUrl,
      metadata: { alertKey: alert.key, source: 'trading_ops_dashboard' },
    })
    await createNotification({
      role: 'ADMIN',
      businessId: TRADING_BUSINESS_ID,
      type: 'ADMIN_ANNOUNCEMENT',
      priority: ALERT_PRIORITY[alert.severity],
      title: alert.title,
      message: alert.message,
      actionUrl: alert.actionUrl,
      metadata: { alertKey: alert.key, source: 'trading_ops_dashboard' },
    })
  }
}

async function dismissStaleTradingAlerts(activeKeys: Set<string>) {
  const rows = await prisma.notification.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      type: 'ADMIN_ANNOUNCEMENT',
      metadataJson: { contains: '"source":"trading_ops_dashboard"' },
      readAt: null,
    },
    select: { id: true, metadataJson: true },
    take: 100,
  })
  const staleIds = rows
    .filter(row => {
      try {
        const meta = JSON.parse(row.metadataJson || '{}') as { alertKey?: string }
        return meta.alertKey && !activeKeys.has(meta.alertKey)
      } catch {
        return false
      }
    })
    .map(row => row.id)
  if (!staleIds.length) return
  const now = new Date()
  await prisma.notification.updateMany({
    where: { id: { in: staleIds } },
    data: { readAt: now, pinned: false, expiresAt: now },
  })
  await prisma.notificationRecipient.updateMany({
    where: { notificationId: { in: staleIds }, readAt: null },
    data: { readAt: now, seenAt: now, acknowledgedAt: now },
  })
}

function groupBy<T, K>(rows: T[], keyFn: (row: T) => K) {
  const map = new Map<K, T[]>()
  for (const row of rows) {
    const key = keyFn(row)
    map.set(key, [...(map.get(key) ?? []), row])
  }
  return map
}

function severityWeight(severity: TradingAlertSeverity) {
  return severity === 'CRITICAL' ? 4 : severity === 'HIGH' ? 3 : severity === 'MEDIUM' ? 2 : 1
}
