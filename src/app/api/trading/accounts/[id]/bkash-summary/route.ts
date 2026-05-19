import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  getTradingContext,
  isResponse,
  moneyDecimal,
  nonNegativeMoneyDecimal,
  parseTradingDate,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  requireTradingWrite,
} from '@/lib/trading'
import { logEvent } from '@/lib/logger'

type RouteContext = { params: { id: string } }

export async function POST(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const account = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await req.json() as {
      summaryDate?: string
      totalOrders?: number
      totalProfitBdt?: number
      totalLossBdt?: number
      notes?: string
    }
    const summaryDate = parseTradingDate(body.summaryDate, 'summaryDate')
    if (isResponse(summaryDate)) return summaryDate
    summaryDate.setHours(0, 0, 0, 0)
    const totalOrders = Number(body.totalOrders || 0)
    if (!Number.isInteger(totalOrders) || totalOrders < 0) return NextResponse.json({ error: 'totalOrders must be a non-negative integer' }, { status: 400 })
    const totalProfitBdt = nonNegativeMoneyDecimal(body.totalProfitBdt ?? 0, 'totalProfitBdt')
    if (isResponse(totalProfitBdt)) return totalProfitBdt
    const totalLossBdt = nonNegativeMoneyDecimal(body.totalLossBdt ?? 0, 'totalLossBdt')
    if (isResponse(totalLossBdt)) return totalLossBdt
    const netResultBdt = moneyDecimal(totalProfitBdt.minus(totalLossBdt))

    const result = await prisma.$transaction(async tx => {
      const summary = await tx.tradingBkashDailySummary.upsert({
        where: { tradingAccountId_summaryDate: { tradingAccountId: params.id, summaryDate } },
        create: {
          tradingAccountId: params.id,
          businessId: TRADING_BUSINESS_ID,
          summaryDate,
          totalOrders,
          totalProfitBdt,
          totalLossBdt,
          netResultBdt,
          notes: String(body.notes || '').trim() || null,
          createdBy: ctx.userId,
        },
        update: {
          totalOrders,
          totalProfitBdt,
          totalLossBdt,
          netResultBdt,
          notes: String(body.notes || '').trim() || null,
          deletedAt: null,
        },
      })
      await refreshTradingDailySnapshot(tx, params.id, summaryDate)
      const accountSummary = await recalculateTradingAccount(tx, params.id)
      return { bkashSummary: summary, summary: accountSummary }
    })

    logEvent('info', 'trading.bkash_summary.saved', { accountId: params.id, actorUserId: ctx.userId, totalOrders, netResultBdt: Number(netResultBdt) })
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
