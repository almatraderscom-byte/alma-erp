import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  getTradingContext,
  isResponse,
  parseTradingDate,
  parseTradeType,
  positiveRateDecimal,
  positiveUsdtDecimal,
  nonNegativeUsdtDecimal,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  requireTradingWrite,
  moneyDecimal,
  tradingOperationCalculations,
} from '@/lib/trading'
import { postTradingCompletionBonus, postTradingTradeCommission } from '@/lib/trading-commission'

function badRequest(message: string, meta: Record<string, unknown>) {
  logEvent('warn', 'trading.trade.validation_failed', { ...meta, message })
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const body = (await req.json()) as {
      tradingAccountId?: string
      userId?: string
      tradeType?: string
      usdtAmount?: number
      bdtRate?: number
      buyRateBdt?: number
      sellRateBdt?: number
      feeUsdt?: number
      tradeDate?: string
      notes?: string
    }
    const tradingAccountId = String(body.tradingAccountId || '').trim()
    logEvent('info', 'trading.trade.submit_received', {
      actorUserId: ctx.userId,
      role: ctx.role,
      tradingAccountId: tradingAccountId || null,
      tradeType: body.tradeType || null,
      hasUsdtAmount: body.usdtAmount != null,
      hasBdtRate: body.bdtRate != null,
    })
    if (!tradingAccountId) return badRequest('tradingAccountId is required', { actorUserId: ctx.userId })

    const account = await prisma.tradingAccount.findFirst({
      where: { id: tradingAccountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true, assignedUserId: true },
    })
    if (!account) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, account)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const tradeType = parseTradeType(body.tradeType ?? (body.buyRateBdt != null && body.sellRateBdt != null ? 'SELL' : undefined))
    if (isResponse(tradeType)) return tradeType
    const usdtAmount = positiveUsdtDecimal(body.usdtAmount, 'usdtAmount')
    if (isResponse(usdtAmount)) return usdtAmount
    const bdtRate = positiveRateDecimal(body.bdtRate ?? (tradeType === 'BUY' ? body.buyRateBdt : body.sellRateBdt), 'bdtRate')
    if (isResponse(bdtRate)) return bdtRate
    const feeUsdt = nonNegativeUsdtDecimal(body.feeUsdt ?? 0, 'feeUsdt')
    if (isResponse(feeUsdt)) return feeUsdt
    const tradeDate = parseTradingDate(body.tradeDate, 'tradeDate')
    if (isResponse(tradeDate)) return tradeDate

    const userId = ctx.isAdmin && body.userId ? String(body.userId).trim() : ctx.userId

    const result = await prisma.$transaction(async tx => {
      const currentAccount = await tx.tradingAccount.findUniqueOrThrow({
        where: { id: tradingAccountId },
        select: { usdtBalance: true, inventoryCostBdt: true },
      })
      if (tradeType === 'SELL' && Number(currentAccount.usdtBalance) + 0.00000001 < Number(usdtAmount)) {
        return {
          error: badRequest('Sell USDT exceeds current account USDT balance. Add BUY entries first.', {
            actorUserId: ctx.userId,
            accountId: tradingAccountId,
            requestedUsdt: Number(usdtAmount),
            currentUsdt: Number(currentAccount.usdtBalance),
          }),
        }
      }
      const averageCostRateBdt = Number(currentAccount.usdtBalance) > 0
        ? moneyDecimal(Number(currentAccount.inventoryCostBdt) / Number(currentAccount.usdtBalance))
        : moneyDecimal(0)
      const calc = tradingOperationCalculations({ tradeType, usdtAmount, bdtRate, feeUsdt, averageCostRateBdt })
      const trade = await tx.tradingTrade.create({
        data: {
          tradingAccountId,
          userId,
          businessId: TRADING_BUSINESS_ID,
          tradeType,
          usdtAmount,
          bdtRate,
          buyRateBdt: tradeType === 'BUY' ? bdtRate : averageCostRateBdt,
          sellRateBdt: tradeType === 'SELL' ? bdtRate : moneyDecimal(0),
          totalBdt: calc.totalBdt,
          netBdt: calc.netBdt,
          costBasisBdt: calc.costBasisBdt,
          buyAmount: calc.buyAmount,
          sellAmount: calc.sellAmount,
          feeUsdt,
          feeBdt: calc.feeBdt,
          feeAmount: calc.feeBdt,
          netProfit: calc.netProfitBdt,
          tradeDate,
          notes: String(body.notes || '').trim() || null,
        },
      })
      const summary = await recalculateTradingAccount(tx, tradingAccountId)
      await refreshTradingDailySnapshot(tx, tradingAccountId, tradeDate, summary)
      return { trade, summary }
    }, { maxWait: 10_000, timeout: 20_000 })
    if ('error' in result) return result.error

    if (tradeType === 'SELL') {
      try {
        const commissionAccount = await prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
          select: {
            id: true,
            accountTitle: true,
            partnershipEnabled: true,
            commissionType: true,
            commissionRate: true,
            fixedCommission: true,
            completionBonus: true,
            assignedUser: { select: { id: true, employeeIdGas: true } },
          },
        })
        if (commissionAccount) {
          await postTradingTradeCommission({
            account: commissionAccount,
            tradeId: result.trade.id,
            tradeDate,
            netProfitBdt: Number(result.trade.netProfit),
            actorUserId: ctx.userId,
          })
          if (result.summary.merchantProgress >= 100) {
            await postTradingCompletionBonus({ account: commissionAccount, actorUserId: ctx.userId })
          }
        }
      } catch (commissionError) {
        logEvent('warn', 'trading.trade.commission_post_failed', {
          actorUserId: ctx.userId,
          accountId: tradingAccountId,
          tradeId: result.trade.id,
          error: commissionError instanceof Error ? commissionError.message : String(commissionError),
        })
      }
    }

    logEvent('info', 'trading.trade.submitted', {
      businessId: TRADING_BUSINESS_ID,
      accountId: tradingAccountId,
      tradeId: result.trade.id,
      actorUserId: ctx.userId,
      userId,
      tradeType,
      usdtAmount: Number(result.trade.usdtAmount),
      netProfitBdt: Number(result.trade.netProfit),
    })

    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (e) {
    logEvent('error', 'trading.trade.submit_failed', {
      actorUserId: ctx.userId,
      error: (e as Error).message,
      stack: (e as Error).stack?.split('\n').slice(0, 5).join('\n'),
    })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
