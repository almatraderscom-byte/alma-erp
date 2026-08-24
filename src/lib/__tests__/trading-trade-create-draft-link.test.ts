import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Telegram draft's POSTED linkage must happen INSIDE the trade's own
 * transaction. Two statements left a window where a committed trade sat against
 * a draft that still looked unposted, and every recovery path would then post it
 * a second time (Codex P1, 2026-08-24).
 *
 * These tests drive the real transaction callback with a fake `tx`, so the field
 * names, the ordering, and the abort-on-lost-race behaviour are all exercised —
 * the confirm-path tests mock `createTradingTradeRecord` wholesale and cannot
 * see inside it.
 */

const txTradeCreate = vi.fn()
const txAccountFindUniqueOrThrow = vi.fn()
const txDraftUpdateMany = vi.fn()
const runTransaction = vi.fn()
const accountFindUnique = vi.fn()
const recalculateTradingAccount = vi.fn()
const refreshTradingDailySnapshot = vi.fn()

/** Records the order of calls so "linked before recalc" is checkable. */
const callOrder: string[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => runTransaction(...args),
    tradingAccount: { findUnique: (...args: unknown[]) => accountFindUnique(...args) },
  },
}))

vi.mock('@/lib/trading', async () => {
  const { Prisma } = await import('@prisma/client')
  return {
    TRADING_BUSINESS_ID: 'ALMA_TRADING',
    moneyDecimal: (v: unknown) => new Prisma.Decimal(Number(v).toFixed(2)),
    usdtDecimal: (v: unknown) => new Prisma.Decimal(Number(v).toFixed(8)),
    rateDecimal: (v: unknown) => new Prisma.Decimal(Number(v).toFixed(4)),
    recalculateTradingAccount: (...args: unknown[]) => {
      callOrder.push('recalculate')
      return recalculateTradingAccount(...args)
    },
    refreshTradingDailySnapshot: (...args: unknown[]) => refreshTradingDailySnapshot(...args),
    tradingOperationCalculations: () => ({
      totalBdt: 0, netBdt: 0, costBasisBdt: 0, buyAmount: 0,
      sellAmount: 0, feeBdt: 0, netProfitBdt: 0,
    }),
  }
})

vi.mock('@/lib/trading-commission', () => ({
  postTradingTradeCommission: vi.fn(),
  postTradingCompletionBonus: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logEvent: vi.fn() }))

import { createTradingTradeRecord } from '@/lib/trading-trade-create'

const tx = {
  tradingAccount: { findUniqueOrThrow: (...a: unknown[]) => txAccountFindUniqueOrThrow(...a) },
  tradingTrade: {
    create: (...a: unknown[]) => {
      callOrder.push('trade.create')
      return txTradeCreate(...a)
    },
  },
  tradingTelegramDraft: {
    updateMany: (...a: unknown[]) => {
      callOrder.push('draft.updateMany')
      return txDraftUpdateMany(...a)
    },
  },
}

function buyInput(extra: Record<string, unknown> = {}) {
  return {
    tradingAccountId: 'acct-1',
    userId: 'staff-1',
    tradeType: 'BUY' as const,
    usdtAmount: 10,
    bdtRate: 120,
    feeUsdt: 0,
    actorUserId: 'reviewer-1',
    ...extra,
  }
}

describe('createTradingTradeRecord — Telegram draft linkage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callOrder.length = 0
    runTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
    txAccountFindUniqueOrThrow.mockResolvedValue({ usdtBalance: 500, inventoryCostBdt: 60000 })
    txTradeCreate.mockResolvedValue({ id: 'trade-1', netProfit: 0 })
    txDraftUpdateMany.mockResolvedValue({ count: 1 })
    recalculateTradingAccount.mockResolvedValue({ merchantProgress: 0 })
    refreshTradingDailySnapshot.mockResolvedValue(undefined)
  })

  it('flips the draft to POSTED inside the same transaction as the trade', async () => {
    await createTradingTradeRecord(buyInput({ linkTelegramDraftId: 'draft-1' }))

    expect(txDraftUpdateMany).toHaveBeenCalledTimes(1)
    const arg = txDraftUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(arg.where).toMatchObject({ id: 'draft-1', status: 'APPROVED', tradingTradeId: null })
    expect(arg.data).toMatchObject({ status: 'POSTED', tradingTradeId: 'trade-1' })
    expect(arg.data.confirmError).toBeNull()
    // Inside the transaction, after the trade row exists.
    expect(callOrder).toEqual(['trade.create', 'draft.updateMany', 'recalculate'])
  })

  it('aborts the transaction when another confirm already took the draft', async () => {
    txDraftUpdateMany.mockResolvedValue({ count: 0 })

    await expect(
      createTradingTradeRecord(buyInput({ linkTelegramDraftId: 'draft-1' })),
    ).rejects.toThrow(/confirmed by someone else/)

    // Throwing inside the callback is what rolls the trade back with it.
    expect(callOrder).toEqual(['trade.create', 'draft.updateMany'])
  })

  it('leaves non-Telegram trades untouched', async () => {
    await createTradingTradeRecord(buyInput())

    expect(txDraftUpdateMany).not.toHaveBeenCalled()
    expect(callOrder).toEqual(['trade.create', 'recalculate'])
  })

  it('still refuses a SELL bigger than the balance, naming both numbers', async () => {
    txAccountFindUniqueOrThrow.mockResolvedValue({ usdtBalance: 156.18, inventoryCostBdt: 30714.42 })

    await expect(
      createTradingTradeRecord(
        buyInput({ tradeType: 'SELL', usdtAmount: 5000, linkTelegramDraftId: 'draft-1' }),
      ),
    ).rejects.toThrow('Sell 5000 USDT exceeds the account balance of 156.18 USDT. Post the matching BUY first, or edit the amount.')

    expect(txTradeCreate).not.toHaveBeenCalled()
    expect(txDraftUpdateMany).not.toHaveBeenCalled()
  })
})
