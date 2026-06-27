import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { TRADING_BUSINESS_ID, numberFromDecimal } from '@/lib/trading'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    if (p.business_id === TRADING_BUSINESS_ID) {
      return NextResponse.json(await tradingFinancialReport(p), { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const data = await serverGet('financial_report', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    logEvent('error', 'finance.report_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load the financial report.', { status: 500 })
  }
}

async function tradingFinancialReport(params: Record<string, string>) {
  const { start, end } = financeDateRange(params)
  const [snapshots, accounts, expenses, trades] = await Promise.all([
    prisma.tradingDailySnapshot.findMany({
      where: { businessId: TRADING_BUSINESS_ID, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    }),
    prisma.tradingAccount.findMany({
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, accountTitle: true, currentBalance: true, totalProfit: true, totalLoss: true },
    }),
    prisma.tradingExpense.aggregate({
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, expenseDate: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.tradingTrade.findMany({
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, tradeDate: { gte: start, lte: end } },
      orderBy: { tradeDate: 'desc' },
      take: 50,
      include: { tradingAccount: { select: { accountTitle: true } } },
    }),
  ])
  // Revenue = sell turnover (what the desk actually transacted). Realised P&L comes
  // from per-trade netProfit, already net of fees, aggregated into grossProfit/Loss —
  // so net profit must NOT subtract fees again (that was double-counting them).
  const monthly = new Map<string, { month: string; revenue: number; profit: number; expenses: number }>()
  for (const row of snapshots) {
    const key = row.date.toISOString().slice(0, 7)
    const item = monthly.get(key) ?? { month: key, revenue: 0, profit: 0, expenses: 0 }
    item.revenue += numberFromDecimal(row.sellBdtVolume)
    item.profit += numberFromDecimal(row.netResultBdt)
    item.expenses += numberFromDecimal(row.expenseBdt)
    monthly.set(key, item)
  }
  for (const item of monthly.values()) {
    item.revenue = roundMoney(item.revenue)
    item.profit = roundMoney(item.profit)
    item.expenses = roundMoney(item.expenses)
  }
  const turnover = roundMoney(snapshots.reduce((sum, row) => sum + numberFromDecimal(row.sellBdtVolume), 0))
  const buyVolume = roundMoney(snapshots.reduce((sum, row) => sum + numberFromDecimal(row.buyBdtVolume), 0))
  const grossProfit = snapshots.reduce((sum, row) => sum + numberFromDecimal(row.grossProfitBdt), 0)
  const grossLoss = snapshots.reduce((sum, row) => sum + numberFromDecimal(row.grossLossBdt), 0)
  const fees = roundMoney(snapshots.reduce((sum, row) => sum + numberFromDecimal(row.feeBdt), 0))
  const expensesTotal = roundMoney(numberFromDecimal(expenses._sum.amount))
  // Canonical realised net = (net-of-fee profit) − (net-of-fee loss) − operating expenses.
  const netProfit = roundMoney(grossProfit - grossLoss - expensesTotal)
  return {
    business_id: TRADING_BUSINESS_ID,
    period_label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
    total_receivable: roundMoney(accounts.reduce((sum, account) => sum + numberFromDecimal(account.currentBalance), 0)),
    monthly_revenue: Array.from(monthly.values()),
    yearly_growth_pct: 0,
    profit_loss: {
      revenue: turnover,
      cogs: buyVolume,
      fees,
      expenses: expensesTotal,
      net_profit: netProfit,
      margin_pct: turnover > 0 ? roundMoney((netProfit / turnover) * 100) : 0,
    },
    cashflow: {
      inflow: turnover,
      outflow: roundMoney(buyVolume + fees + expensesTotal),
      net: roundMoney(turnover - buyVolume - fees - expensesTotal),
    },
    invoice_history: trades.map(trade => ({
      id: trade.id,
      client: trade.tradingAccount.accountTitle,
      amount: numberFromDecimal(trade.sellAmount),
      status: numberFromDecimal(trade.netProfit) >= 0 ? 'Profit' : 'Loss',
      date: trade.tradeDate.toISOString().slice(0, 10),
      total_paid: numberFromDecimal(trade.sellAmount),
      due_amount: 0,
    })),
    top_clients_clv: accounts.map(account => ({
      name: account.accountTitle,
      revenue: numberFromDecimal(account.totalProfit) - numberFromDecimal(account.totalLoss),
      orders: 1,
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
  }
}

function financeDateRange(params: Record<string, string>) {
  const start = params.startDate ? new Date(params.startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  const end = params.endDate ? new Date(params.endDate) : new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}
