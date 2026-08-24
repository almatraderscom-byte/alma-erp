import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression guard for the Telegram quick-entry black hole (2026-08-24):
 * `approveTelegramDraftToLedger` flipped a draft to APPROVED *before* writing the
 * trade and never rolled that back, so any ledger guard (e.g. selling more USDT
 * than the account holds) stranded the draft — gone from the PENDING list, never
 * in the account, and with no button left to retry it.
 */

const draftFindFirst = vi.fn()
const draftFindMany = vi.fn()
const draftUpdate = vi.fn()
const draftUpdateMany = vi.fn()
const auditCreate = vi.fn()
const createTradingTradeRecord = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tradingTelegramDraft: {
      findFirst: (...args: unknown[]) => draftFindFirst(...args),
      findMany: (...args: unknown[]) => draftFindMany(...args),
      update: (...args: unknown[]) => draftUpdate(...args),
      updateMany: (...args: unknown[]) => draftUpdateMany(...args),
    },
    tradingTelegramAuditLog: { create: (...args: unknown[]) => auditCreate(...args) },
  },
}))

vi.mock('@/lib/trading-trade-create', () => ({
  createTradingTradeRecord: (...args: unknown[]) => createTradingTradeRecord(...args),
}))

vi.mock('@/lib/user-display', () => ({ resolveProfileImageForUser: () => null }))

import { approveTelegramDraftToLedger } from '@/lib/trading-telegram-drafts'
import { healStuckApprovedTelegramDrafts } from '@/lib/trading-telegram-lock'
import type { TradingContext } from '@/lib/trading'

const ctx: TradingContext = {
  userId: 'reviewer-1',
  role: 'SUPER_ADMIN',
  isAdmin: true,
  isSuperAdmin: true,
}

/** A complete, confirmable draft owned by the acting user. */
function pendingDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    businessId: 'ALMA_TRADING',
    status: 'PENDING',
    userId: 'staff-1',
    tradingAccountId: 'acct-1',
    tradingTradeId: null,
    tradeType: 'SELL',
    usdtAmount: 127.67,
    bdtRate: 117.72,
    feeUsdt: 0.23,
    telegramUserId: '7921737198',
    telegramChatId: '-5157095212',
    telegramUsername: 'staffer',
    rawMessage: 'S 127.67 117.72 0.23',
    tradingAccount: { id: 'acct-1', assignedUserId: 'staff-1' },
    ...overrides,
  }
}

describe('approveTelegramDraftToLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    draftUpdateMany.mockResolvedValue({ count: 1 })
    draftUpdate.mockResolvedValue({})
    auditCreate.mockResolvedValue({})
  })

  it('rolls the draft back to PENDING with the reason when the ledger rejects it', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft())
    createTradingTradeRecord.mockRejectedValue(
      new Error('Sell 127.67 USDT exceeds the account balance of 28.4 USDT. Post the matching BUY first, or edit the amount.'),
    )

    await expect(approveTelegramDraftToLedger(ctx, 'draft-1')).rejects.toThrow(/exceeds the account balance/)

    const rollback = draftUpdateMany.mock.calls.find(
      call => (call[0] as { data: { status?: string } }).data.status === 'PENDING',
    )
    expect(rollback).toBeDefined()
    const arg = rollback![0] as { where: Record<string, unknown>; data: Record<string, unknown> }
    expect(arg.where).toMatchObject({ id: 'draft-1', status: 'APPROVED', tradingTradeId: null })
    expect(String(arg.data.confirmError)).toMatch(/exceeds the account balance/)
    expect(arg.data.confirmErrorAt).toBeInstanceOf(Date)
  })

  it('never rolls back a draft whose trade actually landed', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft())
    createTradingTradeRecord.mockRejectedValue(new Error('boom'))

    await expect(approveTelegramDraftToLedger(ctx, 'draft-1')).rejects.toThrow('boom')

    const rollback = draftUpdateMany.mock.calls.find(
      call => (call[0] as { data: { status?: string } }).data.status === 'PENDING',
    )
    // The guard that makes the rollback safe: it only matches rows with no trade.
    expect((rollback![0] as { where: { tradingTradeId: unknown } }).where.tradingTradeId).toBeNull()
  })

  it('retries a draft previously stranded in APPROVED instead of refusing it', async () => {
    draftFindFirst
      .mockResolvedValueOnce(pendingDraft({ status: 'APPROVED' })) // loadDraftForActor
      .mockResolvedValueOnce(pendingDraft({ status: 'APPROVED' })) // postDraftToLedger re-read
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-9' }, summary: { merchantProgress: 0 } })

    const result = await approveTelegramDraftToLedger(ctx, 'draft-1')

    expect(result).toEqual({ tradeId: 'trade-9', alreadyPosted: false })
    const claim = draftUpdateMany.mock.calls[0][0] as { where: { status: { in: string[] } } }
    expect(claim.where.status.in).toContain('APPROVED')
  })

  it('is idempotent on a second confirm of an already-posted draft', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft({ status: 'POSTED', tradingTradeId: 'trade-5' }))

    const result = await approveTelegramDraftToLedger(ctx, 'draft-1')

    expect(result).toEqual({ tradeId: 'trade-5', alreadyPosted: true })
    expect(createTradingTradeRecord).not.toHaveBeenCalled()
    expect(draftUpdateMany).not.toHaveBeenCalled()
  })
})

describe('healStuckApprovedTelegramDrafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auditCreate.mockResolvedValue({})
  })

  it('returns APPROVED-but-unposted drafts to PENDING', async () => {
    draftFindMany.mockResolvedValue([
      { id: 'draft-1', telegramUserId: '1', telegramChatId: '-1', reviewedBy: 'reviewer-1', confirmError: null },
    ])
    draftUpdateMany.mockResolvedValue({ count: 1 })

    const healed = await healStuckApprovedTelegramDrafts()

    expect(healed).toBe(1)
    const where = (draftFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ status: 'APPROVED', tradingTradeId: null })
    const update = draftUpdateMany.mock.calls[0][0] as { data: { status: string } }
    expect(update.data.status).toBe('PENDING')
  })

  it('does nothing when no draft is stranded', async () => {
    draftFindMany.mockResolvedValue([])

    expect(await healStuckApprovedTelegramDrafts()).toBe(0)
    expect(draftUpdateMany).not.toHaveBeenCalled()
  })
})
