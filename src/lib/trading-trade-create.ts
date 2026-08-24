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
  /**
   * Telegram draft to mark POSTED *inside the same transaction* as the trade.
   *
   * Writing the trade and linking the draft in two separate statements leaves a
   * window where the ledger row exists but `tradingTradeId` is still null — and
   * anything that later "recovers" that draft (a retry, the stale sweep) posts
   * the trade a second time. Doing the link in-transaction removes the window,
   * and the conditional update doubles as the exclusivity check: only one
   * transaction can flip the claimed draft, the loser aborts and its trade rolls
   * back with it.
   */
  linkTelegramDraftId?: string
}

export async function createTradingTradeRecord(input: CreateTradingTradeInput) {
  // Clone before normalising — setHours mutates, and callers pass Dates they own.
  const tradeDate = new Date(input.tradeDate ?? Date.now())
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
      // Name both numbers: staff hitting this from a Telegram draft could not tell
      // whether the entry was wrong or the account was short.
      throw new Error(
        `Sell ${Number(usdtAmount)} USDT exceeds the account balance of ${Number(currentAccount.usdtBalance)} USDT. ` +
          'Post the matching BUY first, or edit the amount.',
      )
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
    if (input.linkTelegramDraftId) {
      const linked = await tx.tradingTelegramDraft.updateMany({
        where: { id: input.linkTelegramDraftId, status: 'APPROVED', tradingTradeId: null },
        data: {
          status: 'POSTED',
          tradingTradeId: trade.id,
          postedAt: new Date(),
          reviewedBy: input.actorUserId ?? input.userId,
          reviewedAt: new Date(),
          confirmError: null,
          confirmErrorAt: null,
        },
      })
      if (linked.count === 0) {
        throw new Error('Draft was confirmed by someone else — refresh to see the posted trade')
      }
    }
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
