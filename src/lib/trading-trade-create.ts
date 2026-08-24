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
   * Book the trade on this day, but ONLY if no trade on the account is already
   * dated after it. Resolved inside the transaction, under the account lock,
   * because it is a read-then-write: a concurrent confirm committing between an
   * outside check and this insert would leave the sell priced against inventory
   * that did not exist on its day. See the caller for why backdating matters.
   */
  backdateToIfUntouched?: Date
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
    // Serialize everything that touches this account's inventory. The balance
    // guard, the average-cost read and the backdate check below are all
    // read-then-write: without the lock two confirms racing on one account can
    // both pass the balance guard, and both price their sell off pre-trade
    // inventory. Contention is confined to a single account row.
    await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${input.tradingAccountId} FOR UPDATE`

    const currentAccount = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: input.tradingAccountId },
      select: { usdtBalance: true, inventoryCostBdt: true },
    })

    // Under the lock, "nothing newer exists" stays true until this trade lands,
    // so current inventory IS the inventory as of that day.
    let effectiveTradeDate = tradeDate
    if (input.backdateToIfUntouched) {
      // Normalise in UTC, not server-local: the caller hands over an exact UTC
      // day boundary (BD calendar day), and re-deriving it with setHours would
      // shift it a day on any host that is not UTC.
      const day = new Date(input.backdateToIfUntouched)
      day.setUTCHours(0, 0, 0, 0)
      const newer = await tx.tradingTrade.findFirst({
        where: {
          tradingAccountId: input.tradingAccountId,
          businessId: TRADING_BUSINESS_ID,
          deletedAt: null,
          tradeDate: { gt: day },
        },
        select: { id: true },
      })
      if (!newer) effectiveTradeDate = day
    }
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
        tradeDate: effectiveTradeDate,
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
    await refreshTradingDailySnapshot(tx, input.tradingAccountId, effectiveTradeDate, summary)
    return { trade, summary, tradeDate: effectiveTradeDate }
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
          tradeDate: result.tradeDate,
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
