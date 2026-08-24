import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The owner's actual habit (2026-08-24): staff let drafts pile up and confirm a
 * batch when they are free — often hours later, sometimes the next morning. Two
 * things broke under exactly that habit:
 *
 *   1. The batch replayed the day BACKWARDS. The list is `createdAt: 'desc'`, so
 *      "select all pending" sent newest-first and a SELL reached the ledger before
 *      the BUY that funded it — dying on the balance guard.
 *   2. The trade was booked on the day it was CONFIRMED, not the day it was made,
 *      so a late batch landed on the wrong day's P/L and daily snapshot.
 */

const draftFindFirst = vi.fn()
const draftFindMany = vi.fn()
const draftUpdateMany = vi.fn()
const auditCreate = vi.fn()
const createTradingTradeRecord = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tradingTelegramDraft: {
      findFirst: (...a: unknown[]) => draftFindFirst(...a),
      findFirstOrThrow: (...a: unknown[]) => draftFindFirst(...a),
      findMany: (...a: unknown[]) => draftFindMany(...a),
      updateMany: (...a: unknown[]) => draftUpdateMany(...a),
      update: vi.fn(),
    },
    tradingTelegramAuditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  },
}))

vi.mock('@/lib/trading-trade-create', () => ({
  createTradingTradeRecord: (...a: unknown[]) => createTradingTradeRecord(...a),
}))

vi.mock('@/lib/user-display', () => ({ resolveProfileImageForUser: () => null }))

import {
  bulkApproveTelegramDrafts,
  MAX_BULK_CONFIRM,
  postDraftToLedger,
} from '@/lib/trading-telegram-drafts'
import type { TradingContext } from '@/lib/trading'

const ctx: TradingContext = {
  userId: 'reviewer-1',
  role: 'SUPER_ADMIN',
  isAdmin: true,
  isSuperAdmin: true,
}

function draft(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    businessId: 'ALMA_TRADING',
    status: 'PENDING',
    userId: 'staff-1',
    tradingAccountId: 'acct-1',
    tradingTradeId: null,
    tradeType: 'BUY',
    usdtAmount: 100,
    bdtRate: 120,
    feeUsdt: 0,
    telegramUserId: '7921737198',
    telegramChatId: '-5157095212',
    telegramUsername: 'staffer',
    rawMessage: 'B 100 120 0',
    createdAt: new Date(createdAt),
    tradingAccount: { id: 'acct-1', assignedUserId: 'staff-1' },
    ...extra,
  }
}

describe('bulkApproveTelegramDrafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    draftUpdateMany.mockResolvedValue({ count: 1 })
    auditCreate.mockResolvedValue({})
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-x' }, summary: { merchantProgress: 0 } })
  })

  it('posts oldest-first even when the client sends newest-first', async () => {
    // What the drafts list actually hands over: createdAt desc.
    const clientOrder = ['d-late', 'd-mid', 'd-early']
    draftFindMany.mockResolvedValue([{ id: 'd-early' }, { id: 'd-mid' }, { id: 'd-late' }])
    draftFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
      draft(args.where.id, '2026-08-23T10:00:00.000Z'),
    )

    const { results } = await bulkApproveTelegramDrafts(ctx, clientOrder)

    expect(results.map(r => r.id)).toEqual(['d-early', 'd-mid', 'd-late'])
    const orderBy = (draftFindMany.mock.calls[0][0] as { orderBy: unknown }).orderBy
    expect(orderBy).toEqual([{ createdAt: 'asc' }, { tradeNumber: 'asc' }])
  })

  it('leaves an over-cap batch untouched and reports how many are left', async () => {
    const ids = Array.from({ length: MAX_BULK_CONFIRM + 7 }, (_, i) => `d-${i}`)
    draftFindMany.mockResolvedValue(ids.map(id => ({ id })))
    draftFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
      draft(args.where.id, '2026-08-23T10:00:00.000Z'),
    )

    const { results, skipped } = await bulkApproveTelegramDrafts(ctx, ids)

    expect(results).toHaveLength(MAX_BULK_CONFIRM)
    expect(skipped).toBe(7)
  })

  it('keeps going past a draft the ledger rejects, and reports its reason', async () => {
    draftFindMany.mockResolvedValue([{ id: 'd-1' }, { id: 'd-2' }])
    draftFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
      draft(args.where.id, '2026-08-23T10:00:00.000Z'),
    )
    createTradingTradeRecord
      .mockRejectedValueOnce(new Error('Sell 500 USDT exceeds the account balance of 12 USDT.'))
      .mockResolvedValueOnce({ trade: { id: 'trade-2' }, summary: { merchantProgress: 0 } })

    const { results } = await bulkApproveTelegramDrafts(ctx, ['d-1', 'd-2'])

    expect(results.map(r => r.ok)).toEqual([false, true])
    expect(results[0].error).toMatch(/exceeds the account balance/)
  })
})

describe('postDraftToLedger — trade date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-x' }, summary: { merchantProgress: 0 } })
  })

  it('books the trade on the BD day it was typed, not the day it was confirmed', async () => {
    // 2026-08-23 22:35 Dhaka. Confirmed the next afternoon.
    draftFindFirst.mockResolvedValue(draft('d-1', '2026-08-23T16:35:00.000Z', { status: 'APPROVED' }))

    await postDraftToLedger('d-1', 'reviewer-1')

    const input = createTradingTradeRecord.mock.calls[0][0] as { tradeDate: Date }
    expect(input.tradeDate.toISOString()).toBe('2026-08-23T00:00:00.000Z')
  })

  it('keeps a late-evening draft on its own Dhaka day, not the previous UTC one', async () => {
    // 2026-08-24 00:30 Dhaka is still 2026-08-23 18:30 UTC — the old code booked
    // this one a day early.
    draftFindFirst.mockResolvedValue(draft('d-2', '2026-08-23T18:30:00.000Z', { status: 'APPROVED' }))

    await postDraftToLedger('d-2', 'reviewer-1')

    const input = createTradingTradeRecord.mock.calls[0][0] as { tradeDate: Date }
    expect(input.tradeDate.toISOString()).toBe('2026-08-24T00:00:00.000Z')
  })
})
