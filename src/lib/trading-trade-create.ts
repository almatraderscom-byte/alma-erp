import { Prisma, type TradingTradeType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  moneyDecimal,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  tradingOperationCalculations,
  usdtDecimal,
  rateDecimal,
} from '@/lib/trading'
import { postTradingCompletionBonus, postTradingTradeCommission } from '@/lib/trading-commission'

export type CreateTradingTradeInput = {
  tradingAccountId: string
  userId: string
  tradeType: TradingTradeType
  usdtAmount: number
  bdtRate: number
  feeUsdt: number
  tradeDate?: Date
  notes?: string | null
  actorUserId?: string
}

export async function createTradingTradeRecord(input: CreateTradingTradeInput) {
  const tradeDate = input.tradeDate ?? new Date()
  tradeDate.setHours(0, 0, 0, 0)
  const usdtAmount = usdtDecimal(input.usdtAmount)
  const bdtRate = rateDecimal(input.bdtRate)
  const feeUsdt = usdtDecimal(input.feeUsdt)

  const result = await prisma.$transaction(async tx => {
    const currentAccount = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: input.tradingAccountId },
      select: { usdtBalance: true, inventoryCostBdt: true },
    })
    if (input.tradeType === 'SELL' && Number(currentAccount.usdtBalance) + 0.00000001 < Number(usdtAmount)) {
      throw new Error('Sell USDT exceeds current account USDT balance.')
    }
    const averageCostRateBdt = Number(currentAccount.usdtBalance) > 0
      ? moneyDecimal(Number(currentAccount.inventoryCostBdt) / Number(currentAccount.usdtBalance))
      : moneyDecimal(0)
    const calc = tradingOperationCalculations({
      tradeType: input.tradeType,
      usdtAmount,
      bdtRate,
      feeUsdt,
      averageCostRateBdt,
    })
    const trade = await tx.tradingTrade.create({
      data: {
        tradingAccountId: input.tradingAccountId,
        userId: input.userId,
        businessId: TRADING_BUSINESS_ID,
        tradeType: input.tradeType,
        usdtAmount,
        bdtRate,
        buyRateBdt: input.tradeType === 'BUY' ? bdtRate : averageCostRateBdt,
        sellRateBdt: input.tradeType === 'SELL' ? bdtRate : moneyDecimal(0),
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
        notes: input.notes?.trim() || null,
      },
    })
    const summary = await recalculateTradingAccount(tx, input.tradingAccountId)
    await refreshTradingDailySnapshot(tx, input.tradingAccountId, tradeDate, summary)
    return { trade, summary }
  }, { maxWait: 10_000, timeout: 20_000 })

  if (input.tradeType === 'SELL') {
    try {
      const commissionAccount = await prisma.tradingAccount.findUnique({
        where: { id: input.tradingAccountId },
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
          actorUserId: input.actorUserId ?? input.userId,
        })
        if (result.summary.merchantProgress >= 100) {
          await postTradingCompletionBonus({ account: commissionAccount, actorUserId: input.actorUserId ?? input.userId })
        }
      }
    } catch (commissionError) {
      logEvent('warn', 'trading.trade.commission_post_failed', {
        accountId: input.tradingAccountId,
        tradeId: result.trade.id,
        error: commissionError instanceof Error ? commissionError.message : String(commissionError),
      })
    }
  }

  return result
}
