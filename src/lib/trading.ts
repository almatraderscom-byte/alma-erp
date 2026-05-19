import { NextResponse, type NextRequest } from 'next/server'
import { Prisma, type TradingAccount, type TradingAccountType, type TradingCapitalEntryType, type TradingTradeType } from '@prisma/client'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed } from '@/lib/business-access'
import { normalizeAlmaRole, type AlmaRole } from '@/lib/roles'

export const TRADING_BUSINESS_ID = 'ALMA_TRADING'
export const TRADING_ADMIN_ROLES: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN']

export type TradingContext = {
  userId: string
  role: AlmaRole
  isAdmin: boolean
  isSuperAdmin: boolean
}

type TradingError = { error: NextResponse }

export type TradingAccountSummary = {
  accountId: string
  businessId: string
  startingCapital: number
  currentBalance: number
  totalProfit: number
  totalLoss: number
  totalFees: number
  totalExpenses: number
  totalWithdrawals: number
  totalTrades: number
  totalTradedUsdt: number
  totalBuyUsdt: number
  totalSellUsdt: number
  totalBuyBdt: number
  totalSellBdt: number
  usdtBalance: number
  inventoryCostBdt: number
  averageBuyRate: number
  averageSellRate: number
  averageSpread: number
  netTradingProfit: number
  netOperationalProfit: number
  roiPct: number
  deposits: number
  withdrawals: number
  adjustments: number
  merchantTarget: number | null
  merchantProgress: number
}

export type TradingDailySummary = {
  tradesCount: number
  bkashOrders: number
  usdtVolume: number
  buyUsdtVolume: number
  sellUsdtVolume: number
  buyBdtVolume: number
  sellBdtVolume: number
  profit: number
  loss: number
  bkashProfit: number
  bkashLoss: number
  fees: number
  expenses: number
  netResult: number
}

export async function getTradingContext(req: NextRequest): Promise<TradingContext | TradingError> {
  const token = await getJwt(req)
  if (!token?.sub) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN' && !businessAllowed(token.businessAccess as string, TRADING_BUSINESS_ID)) {
    return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  }
  return {
    userId: token.sub,
    role,
    isAdmin: TRADING_ADMIN_ROLES.includes(role),
    isSuperAdmin: role === 'SUPER_ADMIN',
  }
}

export {
  requireTradingSuperAdmin,
  requireTradingVolumeTargetView,
  canManageTradingVolumeTargets,
  canViewTradingVolumeTargets,
} from '@/lib/trading-volume-target-access'

export function requireTradingAdmin(ctx: TradingContext) {
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

export function requireTradingWrite(ctx: TradingContext) {
  if (ctx.role === 'VIEWER') return NextResponse.json({ error: 'Read-only users cannot modify data.' }, { status: 403 })
  return null
}

export function canAccessTradingAccount(ctx: TradingContext, account: Pick<TradingAccount, 'assignedUserId'>) {
  return ctx.isAdmin || account.assignedUserId === ctx.userId
}

export function tradingAccountWhereForContext(ctx: TradingContext) {
  return {
    businessId: TRADING_BUSINESS_ID,
    deletedAt: null,
    ...(ctx.isAdmin ? {} : { assignedUserId: ctx.userId }),
  }
}

export function moneyDecimal(value: unknown): Prisma.Decimal {
  const n = Number(value)
  if (!Number.isFinite(n)) return new Prisma.Decimal(0)
  return new Prisma.Decimal(n.toFixed(2))
}

export function usdtDecimal(value: unknown): Prisma.Decimal {
  const n = Number(value)
  if (!Number.isFinite(n)) return new Prisma.Decimal(0)
  return new Prisma.Decimal(n.toFixed(8))
}

export function rateDecimal(value: unknown): Prisma.Decimal {
  const n = Number(value)
  if (!Number.isFinite(n)) return new Prisma.Decimal(0)
  return new Prisma.Decimal(n.toFixed(4))
}

export function positiveMoneyDecimal(value: unknown, field: string): Prisma.Decimal | NextResponse {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return NextResponse.json({ error: `${field} must be greater than 0` }, { status: 400 })
  }
  return new Prisma.Decimal(n.toFixed(2))
}

export function positiveUsdtDecimal(value: unknown, field: string): Prisma.Decimal | NextResponse {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return NextResponse.json({ error: `${field} must be greater than 0` }, { status: 400 })
  }
  return usdtDecimal(n)
}

export function positiveRateDecimal(value: unknown, field: string): Prisma.Decimal | NextResponse {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return NextResponse.json({ error: `${field} must be greater than 0` }, { status: 400 })
  }
  return rateDecimal(n)
}

export function nonNegativeUsdtDecimal(value: unknown, field: string): Prisma.Decimal | NextResponse {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    return NextResponse.json({ error: `${field} must be 0 or greater` }, { status: 400 })
  }
  return usdtDecimal(n)
}

export function nonNegativeMoneyDecimal(value: unknown, field: string): Prisma.Decimal | NextResponse {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    return NextResponse.json({ error: `${field} must be 0 or greater` }, { status: 400 })
  }
  return new Prisma.Decimal(n.toFixed(2))
}

export function parseTradingDate(value: unknown, field: string): Date | NextResponse {
  const date = value ? new Date(String(value)) : new Date()
  if (Number.isNaN(date.getTime())) {
    return NextResponse.json({ error: `${field} must be a valid date` }, { status: 400 })
  }
  return date
}

export function isResponse<T>(value: T | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}

export function parseAccountType(value: unknown): TradingAccountType | NextResponse {
  const raw = String(value || 'BINANCE_P2P').trim().toUpperCase()
  if (raw === 'BINANCE_P2P' || raw === 'MERCHANT' || raw === 'STAFF_OPERATED' || raw === 'OTHER') {
    return raw
  }
  return NextResponse.json({ error: 'accountType must be BINANCE_P2P, MERCHANT, STAFF_OPERATED, or OTHER' }, { status: 400 })
}

export function parseCapitalEntryType(value: unknown): TradingCapitalEntryType | NextResponse {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'DEPOSIT' || raw === 'WITHDRAW' || raw === 'ADJUSTMENT') return raw
  return NextResponse.json({ error: 'entryType must be DEPOSIT, WITHDRAW, or ADJUSTMENT' }, { status: 400 })
}

export function parseTradeType(value: unknown): TradingTradeType | NextResponse {
  const raw = String(value || '').trim().toUpperCase()
  if (raw === 'BUY' || raw === 'SELL') return raw
  return NextResponse.json({ error: 'tradeType must be BUY or SELL' }, { status: 400 })
}

function decimalNumber(value: unknown): number {
  return Number(value || 0)
}

export function numberFromDecimal(value: unknown): number {
  return decimalNumber(value)
}

export function todayRange(now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

export function dayRange(date = new Date()) {
  return todayRange(date)
}

export function normalizeSnapshotDate(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function tradingTradeCalculations(input: {
  usdtAmount: Prisma.Decimal
  buyRateBdt: Prisma.Decimal
  sellRateBdt: Prisma.Decimal
  feeUsdt: Prisma.Decimal
}) {
  const buyTotalBdt = input.usdtAmount.mul(input.buyRateBdt)
  const sellTotalBdt = input.usdtAmount.mul(input.sellRateBdt)
  const feeBdt = input.feeUsdt.mul(input.sellRateBdt)
  const netProfitBdt = sellTotalBdt.minus(buyTotalBdt).minus(feeBdt)
  return {
    buyTotalBdt: moneyDecimal(buyTotalBdt),
    sellTotalBdt: moneyDecimal(sellTotalBdt),
    feeBdt: moneyDecimal(feeBdt),
    netProfitBdt: moneyDecimal(netProfitBdt),
  }
}

export function tradingOperationCalculations(input: {
  tradeType: TradingTradeType
  usdtAmount: Prisma.Decimal
  bdtRate: Prisma.Decimal
  feeUsdt: Prisma.Decimal
  averageCostRateBdt?: Prisma.Decimal
}) {
  const totalBdt = input.usdtAmount.mul(input.bdtRate)
  const feeBdt = input.feeUsdt.mul(input.bdtRate)
  if (input.tradeType === 'BUY') {
    const netBuyCost = totalBdt.plus(feeBdt)
    return {
      totalBdt: moneyDecimal(totalBdt),
      feeBdt: moneyDecimal(feeBdt),
      netBdt: moneyDecimal(netBuyCost),
      costBasisBdt: moneyDecimal(netBuyCost),
      buyAmount: moneyDecimal(totalBdt),
      sellAmount: moneyDecimal(0),
      netProfitBdt: moneyDecimal(0),
    }
  }
  const netReceive = totalBdt.minus(feeBdt)
  const costBasis = input.usdtAmount.mul(input.averageCostRateBdt ?? new Prisma.Decimal(0))
  return {
    totalBdt: moneyDecimal(totalBdt),
    feeBdt: moneyDecimal(feeBdt),
    netBdt: moneyDecimal(netReceive),
    costBasisBdt: moneyDecimal(costBasis),
    buyAmount: moneyDecimal(costBasis),
    sellAmount: moneyDecimal(totalBdt),
    netProfitBdt: moneyDecimal(netReceive.minus(costBasis)),
  }
}

export function summaryRange(kind: 'today' | 'yesterday' | 'last7' | 'month', now = new Date()) {
  const today = normalizeSnapshotDate(now)
  if (kind === 'today') return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) }
  if (kind === 'yesterday') {
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    return { start, end: today }
  }
  if (kind === 'last7') {
    const start = new Date(today)
    start.setDate(start.getDate() - 6)
    return { start, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) }
  }
  return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: new Date(today.getTime() + 24 * 60 * 60 * 1000) }
}

export async function getTradingDailySummary(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  date = new Date(),
): Promise<TradingDailySummary> {
  const { start, end } = todayRange(date)
  const [trades, expenses, bkash] = await Promise.all([
    tx.tradingTrade.findMany({
      where: {
        tradingAccountId,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        tradeDate: { gte: start, lt: end },
      },
      select: { tradeType: true, usdtAmount: true, buyAmount: true, sellAmount: true, totalBdt: true, netProfit: true, feeBdt: true, feeAmount: true },
    }),
    tx.tradingExpense.findMany({
      where: {
        tradingAccountId,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        expenseDate: { gte: start, lt: end },
      },
      select: { amount: true },
    }),
    tx.tradingBkashDailySummary.findMany({
      where: {
        tradingAccountId,
        businessId: TRADING_BUSINESS_ID,
        deletedAt: null,
        summaryDate: { gte: start, lt: end },
      },
      select: { totalOrders: true, totalProfitBdt: true, totalLossBdt: true, netResultBdt: true },
    }),
  ])
  const profit = trades.reduce((sum, trade) => {
    const net = decimalNumber(trade.netProfit)
    return net > 0 ? sum + net : sum
  }, 0)
  const loss = trades.reduce((sum, trade) => {
    const net = decimalNumber(trade.netProfit)
    return net < 0 ? sum + Math.abs(net) : sum
  }, 0)
  const fees = trades.reduce((sum, trade) => sum + decimalNumber(trade.feeBdt || trade.feeAmount), 0)
  const usdtVolume = trades.reduce((sum, trade) => sum + decimalNumber(trade.usdtAmount), 0)
  const buyUsdtVolume = trades.reduce((sum, trade) => trade.tradeType === 'BUY' ? sum + decimalNumber(trade.usdtAmount) : sum, 0)
  const sellUsdtVolume = trades.reduce((sum, trade) => trade.tradeType === 'SELL' ? sum + decimalNumber(trade.usdtAmount) : sum, 0)
  const buyBdtVolume = trades.reduce((sum, trade) => trade.tradeType === 'BUY' ? sum + decimalNumber(trade.buyAmount || trade.totalBdt) : sum, 0)
  const sellBdtVolume = trades.reduce((sum, trade) => trade.tradeType === 'SELL' ? sum + decimalNumber(trade.sellAmount || trade.totalBdt) : sum, 0)
  const bkashOrders = bkash.reduce((sum, row) => sum + row.totalOrders, 0)
  const bkashProfit = bkash.reduce((sum, row) => sum + decimalNumber(row.totalProfitBdt), 0)
  const bkashLoss = bkash.reduce((sum, row) => sum + decimalNumber(row.totalLossBdt), 0)
  const expenseTotal = expenses.reduce((sum, expense) => sum + decimalNumber(expense.amount), 0)
  return {
    tradesCount: trades.length + bkashOrders,
    bkashOrders,
    usdtVolume,
    buyUsdtVolume,
    sellUsdtVolume,
    buyBdtVolume,
    sellBdtVolume,
    profit: profit + bkashProfit,
    loss: loss + bkashLoss,
    bkashProfit,
    bkashLoss,
    fees,
    expenses: expenseTotal,
    netResult: profit + bkashProfit - loss - bkashLoss - expenseTotal,
  }
}

export async function recalculateTradingAccount(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
): Promise<TradingAccountSummary> {
  const account = await tx.tradingAccount.findUniqueOrThrow({ where: { id: tradingAccountId } })
  const tradeWhere = { tradingAccountId, businessId: account.businessId, deletedAt: null }
  const [tradeAgg, tradeGroups, profitAgg, lossAgg, bkashAgg, expenseAgg, capitalGroups] = await Promise.all([
    tx.tradingTrade.aggregate({
      where: tradeWhere,
      _count: { _all: true },
      _sum: { usdtAmount: true, buyAmount: true, sellAmount: true, feeBdt: true, feeAmount: true },
    }),
    tx.tradingTrade.groupBy({
      by: ['tradeType'],
      where: tradeWhere,
      _sum: { usdtAmount: true, buyAmount: true, sellAmount: true, netBdt: true, costBasisBdt: true },
    }),
    tx.tradingTrade.aggregate({
      where: { ...tradeWhere, netProfit: { gt: 0 } },
      _sum: { netProfit: true },
    }),
    tx.tradingTrade.aggregate({
      where: { ...tradeWhere, netProfit: { lt: 0 } },
      _sum: { netProfit: true },
    }),
    tx.tradingBkashDailySummary.aggregate({
      where: { tradingAccountId, businessId: account.businessId, deletedAt: null },
      _sum: { totalOrders: true, totalProfitBdt: true, totalLossBdt: true, netResultBdt: true },
    }),
    tx.tradingExpense.aggregate({
      where: { tradingAccountId, businessId: account.businessId, deletedAt: null },
      _sum: { amount: true },
    }),
    tx.tradingCapitalEntry.groupBy({
      by: ['entryType'],
      where: { tradingAccountId, businessId: account.businessId, deletedAt: null },
      _sum: { amount: true },
    }),
  ])

  const buyGroup = tradeGroups.find(group => group.tradeType === 'BUY')
  const sellGroup = tradeGroups.find(group => group.tradeType === 'SELL')
  const totalProfit = decimalNumber(profitAgg._sum.netProfit) + decimalNumber(bkashAgg._sum.totalProfitBdt)
  const totalLoss = Math.abs(decimalNumber(lossAgg._sum.netProfit)) + decimalNumber(bkashAgg._sum.totalLossBdt)
  const totalFees = decimalNumber(tradeAgg._sum.feeBdt) || decimalNumber(tradeAgg._sum.feeAmount)
  const totalTradedUsdt = decimalNumber(tradeAgg._sum.usdtAmount)
  const totalBuyUsdt = decimalNumber(buyGroup?._sum.usdtAmount)
  const totalSellUsdt = decimalNumber(sellGroup?._sum.usdtAmount)
  const totalBuyBdt = decimalNumber(buyGroup?._sum.buyAmount || buyGroup?._sum.netBdt)
  const totalSellBdt = decimalNumber(sellGroup?._sum.sellAmount || sellGroup?._sum.netBdt)
  const totalExpenses = decimalNumber(expenseAgg._sum.amount)
  const deposits = capitalGroups.reduce((sum, entry) => entry.entryType === 'DEPOSIT' ? sum + decimalNumber(entry._sum.amount) : sum, 0)
  const withdrawals = capitalGroups.reduce((sum, entry) => entry.entryType === 'WITHDRAW' ? sum + decimalNumber(entry._sum.amount) : sum, 0)
  const adjustments = capitalGroups.reduce((sum, entry) => entry.entryType === 'ADJUSTMENT' ? sum + decimalNumber(entry._sum.amount) : sum, 0)
  const netTradingProfit = totalProfit - totalLoss
  const netOperationalProfit = netTradingProfit - totalExpenses
  const managedCapitalBase = decimalNumber(account.startingCapital) + deposits + adjustments
  const usdtBalance = totalBuyUsdt - totalSellUsdt
  const inventoryCostBdt = Math.max(0, decimalNumber(buyGroup?._sum.costBasisBdt || buyGroup?._sum.netBdt) - decimalNumber(sellGroup?._sum.costBasisBdt))
  const currentBalance = managedCapitalBase + netTradingProfit - totalExpenses - withdrawals
  const averageBuyRate = totalBuyUsdt > 0 ? totalBuyBdt / totalBuyUsdt : 0
  const averageSellRate = totalSellUsdt > 0 ? totalSellBdt / totalSellUsdt : 0
  const averageSpread = averageSellRate - averageBuyRate
  const roiPct = managedCapitalBase > 0 ? ((netTradingProfit - totalExpenses - withdrawals) / managedCapitalBase) * 100 : 0
  const merchantProgress = account.merchantTarget && decimalNumber(account.merchantTarget) > 0
    ? Math.min(100, Math.max(0, (netTradingProfit / decimalNumber(account.merchantTarget)) * 100))
    : decimalNumber(account.merchantProgress)

  const updated = await tx.tradingAccount.update({
    where: { id: tradingAccountId },
    data: {
      currentBalance: moneyDecimal(currentBalance),
      totalProfit: moneyDecimal(totalProfit),
      totalLoss: moneyDecimal(totalLoss),
      totalFees: moneyDecimal(totalFees),
      totalExpenses: moneyDecimal(totalExpenses),
      totalWithdrawals: moneyDecimal(withdrawals),
      netRoi: moneyDecimal(roiPct),
      totalBuyUsdt: usdtDecimal(totalBuyUsdt),
      totalSellUsdt: usdtDecimal(totalSellUsdt),
      totalBuyBdt: moneyDecimal(totalBuyBdt),
      totalSellBdt: moneyDecimal(totalSellBdt),
      usdtBalance: usdtDecimal(usdtBalance),
      inventoryCostBdt: moneyDecimal(inventoryCostBdt),
      merchantProgress: moneyDecimal(merchantProgress),
    },
  })

  if (currentBalance < 0 && decimalNumber(account.currentBalance) >= 0) {
    await tx.notification.create({
      data: {
        roleTarget: 'SUPER_ADMIN',
        businessId: TRADING_BUSINESS_ID,
        type: 'ADMIN_ANNOUNCEMENT',
        priority: 'HIGH',
        title: 'Trading account negative balance',
        message: `${account.accountTitle} balance is negative: BDT ${Math.abs(Math.round(currentBalance)).toLocaleString('en-BD')}.`,
        actionUrl: `/trading/accounts/${account.id}`,
      },
    })
  }
  await syncTradingBalanceAlertState(tx, {
    accountId: account.id,
    accountTitle: account.accountTitle,
    currentBalance,
    startingCapital: decimalNumber(account.startingCapital),
  })

  return {
    accountId: updated.id,
    businessId: updated.businessId,
    startingCapital: decimalNumber(updated.startingCapital),
    currentBalance,
    totalProfit,
    totalLoss,
    totalFees,
    totalExpenses,
    totalWithdrawals: withdrawals,
    totalTrades: tradeAgg._count._all + Number(bkashAgg._sum.totalOrders || 0),
    totalTradedUsdt,
    totalBuyUsdt,
    totalSellUsdt,
    totalBuyBdt,
    totalSellBdt,
    usdtBalance,
    inventoryCostBdt,
    averageBuyRate,
    averageSellRate,
    averageSpread,
    netTradingProfit,
    netOperationalProfit,
    roiPct,
    deposits,
    withdrawals,
    adjustments,
    merchantTarget: updated.merchantTarget == null ? null : decimalNumber(updated.merchantTarget),
    merchantProgress,
  }
}

async function syncTradingBalanceAlertState(
  tx: Prisma.TransactionClient,
  input: { accountId: string; accountTitle: string; currentBalance: number; startingCapital: number },
) {
  const balanceCritical = input.currentBalance < 0 || (input.startingCapital > 0 && input.currentBalance <= input.startingCapital * 0.2)
  if (balanceCritical) return
  const stale = await tx.notification.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      type: 'ADMIN_ANNOUNCEMENT',
      priority: 'CRITICAL',
      actionUrl: `/trading/accounts/${input.accountId}`,
      metadataJson: { contains: `${input.accountId}:critical-balance` },
      readAt: null,
    },
    select: { id: true },
    take: 50,
  })
  if (!stale.length) return
  const now = new Date()
  const ids = stale.map(row => row.id)
  await tx.notification.updateMany({
    where: { id: { in: ids } },
    data: { readAt: now, pinned: false, expiresAt: now },
  })
  await tx.notificationRecipient.updateMany({
    where: { notificationId: { in: ids }, readAt: null },
    data: { readAt: now, seenAt: now, acknowledgedAt: now },
  })
}

export async function refreshTradingDailySnapshot(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  date = new Date(),
  accountSummary?: TradingAccountSummary,
) {
  const day = normalizeSnapshotDate(date)
  const account = await tx.tradingAccount.findUniqueOrThrow({ where: { id: tradingAccountId } })
  const daily = await getTradingDailySummary(tx, tradingAccountId, day)
  const summary = accountSummary ?? await recalculateTradingAccount(tx, tradingAccountId)
  return tx.tradingDailySnapshot.upsert({
    where: { tradingAccountId_date: { tradingAccountId, date: day } },
    create: {
      businessId: account.businessId,
      tradingAccountId,
      date: day,
      tradeCount: daily.tradesCount,
      usdtVolume: usdtDecimal(daily.usdtVolume),
      buyUsdtVolume: usdtDecimal(daily.buyUsdtVolume),
      sellUsdtVolume: usdtDecimal(daily.sellUsdtVolume),
      buyBdtVolume: moneyDecimal(daily.buyBdtVolume),
      sellBdtVolume: moneyDecimal(daily.sellBdtVolume),
      grossProfitBdt: moneyDecimal(daily.profit),
      grossLossBdt: moneyDecimal(daily.loss),
      feeBdt: moneyDecimal(daily.fees),
      expenseBdt: moneyDecimal(daily.expenses),
      netResultBdt: moneyDecimal(daily.netResult),
      balanceSnapshot: moneyDecimal(summary.currentBalance),
    },
    update: {
      tradeCount: daily.tradesCount,
      usdtVolume: usdtDecimal(daily.usdtVolume),
      buyUsdtVolume: usdtDecimal(daily.buyUsdtVolume),
      sellUsdtVolume: usdtDecimal(daily.sellUsdtVolume),
      buyBdtVolume: moneyDecimal(daily.buyBdtVolume),
      sellBdtVolume: moneyDecimal(daily.sellBdtVolume),
      grossProfitBdt: moneyDecimal(daily.profit),
      grossLossBdt: moneyDecimal(daily.loss),
      feeBdt: moneyDecimal(daily.fees),
      expenseBdt: moneyDecimal(daily.expenses),
      netResultBdt: moneyDecimal(daily.netResult),
      balanceSnapshot: moneyDecimal(summary.currentBalance),
    },
  })
}
