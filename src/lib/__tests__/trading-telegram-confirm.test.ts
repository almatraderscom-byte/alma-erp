import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression guard for the Telegram quick-entry black hole (2026-08-24):
 * `approveTelegramDraftToLedger` flipped a draft to APPROVED *before* writing the
 * trade and never rolled that back, so any ledger guard (e.g. selling more USDT
 * than the account holds) stranded the draft — gone from the PENDING list, never
 * in the account, and with no button left to retry it.
 *
 * The two rules the fix must never lose (both raised on review as duplicate-trade
 * risks):
 *   1. The claim is EXCLUSIVE — only a PENDING draft can be claimed, so two
 *      reviewers confirming at once cannot both proceed to the ledger.
 *   2. The trade and the draft's POSTED linkage commit in ONE transaction, so
 *      there is no window where a trade exists but the draft still looks
 *      unposted (which every recovery path would then post again).
 */

const draftFindFirst = vi.fn()
const draftFindFirstOrThrow = vi.fn()
const draftFindMany = vi.fn()
const draftUpdate = vi.fn()
const draftUpdateMany = vi.fn()
const auditCreate = vi.fn()
const createTradingTradeRecord = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tradingTelegramDraft: {
      findFirst: (...args: unknown[]) => draftFindFirst(...args),
      findFirstOrThrow: (...args: unknown[]) => draftFindFirstOrThrow(...args),
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

import {
  approveTelegramDraftToLedger,
  rejectTelegramDraftRecord,
  updateTelegramDraft,
} from '@/lib/trading-telegram-drafts'
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
    // The ledger books a draft on the BD day it was typed, so the fixture needs a
    // real createdAt — 2026-08-23 22:35 Dhaka, the row this whole file is about.
    createdAt: new Date('2026-08-23T16:35:00.000Z'),
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

  it('claims only from PENDING so two concurrent reviewers cannot both post', async () => {
    draftFindFirst.mockResolvedValueOnce(pendingDraft()).mockResolvedValueOnce(pendingDraft())
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-9' }, summary: { merchantProgress: 0 } })

    await approveTelegramDraftToLedger(ctx, 'draft-1')

    const claim = draftUpdateMany.mock.calls[0][0] as { where: { status: unknown } }
    // A `status: { in: ['PENDING','APPROVED'] }` claim would let the second
    // reviewer "win" too, and both would reach the ledger.
    expect(claim.where.status).toBe('PENDING')
  })

  it('recovers a stranded APPROVED draft before claiming it, then posts once', async () => {
    draftFindFirst
      .mockResolvedValueOnce(pendingDraft({ status: 'APPROVED' })) // loadDraftForActor
      .mockResolvedValueOnce(pendingDraft())                       // postDraftToLedger re-read
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-9' }, summary: { merchantProgress: 0 } })

    const result = await approveTelegramDraftToLedger(ctx, 'draft-1')

    expect(result).toEqual({ tradeId: 'trade-9', alreadyPosted: false })
    // First write is the recovery (APPROVED → PENDING, staleness-guarded), and
    // only then the exclusive claim.
    const recovery = draftUpdateMany.mock.calls[0][0] as { where: Record<string, unknown> }
    expect(recovery.where).toMatchObject({ status: 'APPROVED', tradingTradeId: null })
    expect(recovery.where.OR).toBeDefined()
    const claim = draftUpdateMany.mock.calls[1][0] as { where: { status: unknown } }
    expect(claim.where.status).toBe('PENDING')
  })

  it('links the draft inside the trade transaction, never as a second write', async () => {
    draftFindFirst.mockResolvedValueOnce(pendingDraft()).mockResolvedValueOnce(pendingDraft())
    createTradingTradeRecord.mockResolvedValue({ trade: { id: 'trade-9' }, summary: { merchantProgress: 0 } })

    await approveTelegramDraftToLedger(ctx, 'draft-1')

    const input = createTradingTradeRecord.mock.calls[0][0] as { linkTelegramDraftId?: string }
    expect(input.linkTelegramDraftId).toBe('draft-1')
    // No post-transaction `update` may set POSTED — that write is what left a
    // committed trade attached to an apparently-unposted draft.
    expect(draftUpdate).not.toHaveBeenCalled()
  })

  it('is idempotent on a second confirm of an already-posted draft', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft({ status: 'POSTED', tradingTradeId: 'trade-5' }))

    const result = await approveTelegramDraftToLedger(ctx, 'draft-1')

    expect(result).toEqual({ tradeId: 'trade-5', alreadyPosted: true })
    expect(createTradingTradeRecord).not.toHaveBeenCalled()
    expect(draftUpdateMany).not.toHaveBeenCalled()
  })
})

describe('editing and rejecting a claimed draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auditCreate.mockResolvedValue({})
    draftFindFirstOrThrow.mockResolvedValue(pendingDraft())
  })

  it('edits only an unclaimed draft, so a mid-flight confirm cannot post stale numbers', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft())
    draftUpdateMany.mockResolvedValue({ count: 1 })

    await updateTelegramDraft(ctx, 'draft-1', { usdtAmount: 12 })

    const where = (draftUpdateMany.mock.calls[0][0] as { where: { status: unknown } }).where
    expect(where.status).toBe('PENDING')
  })

  it('refuses the edit when the draft is already claimed', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft({ status: 'APPROVED' }))
    draftUpdateMany.mockResolvedValue({ count: 0 })

    await expect(updateTelegramDraft(ctx, 'draft-1', { usdtAmount: 12 }))
      .rejects.toThrow(/being confirmed right now/)
  })

  it('refuses the reject when the draft is already claimed', async () => {
    draftFindFirst.mockResolvedValue(pendingDraft({ status: 'APPROVED' }))
    draftUpdateMany.mockResolvedValue({ count: 0 })

    await expect(rejectTelegramDraftRecord(ctx, 'draft-1', 'nope'))
      .rejects.toThrow(/being confirmed right now/)

    const where = (draftUpdateMany.mock.calls[0][0] as { where: { status: { in: string[] } } }).where
    // LOCKED stays rejectable by an admin; APPROVED does not.
    expect(where.status.in).toEqual(['PENDING', 'LOCKED'])
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

  it('logs a recovery only for the rows this sweep actually moved', async () => {
    draftFindMany.mockResolvedValue([
      { id: 'draft-1', telegramUserId: '1', telegramChatId: '-1', reviewedBy: 'reviewer-1' },
      { id: 'draft-2', telegramUserId: '2', telegramChatId: '-2', reviewedBy: null },
    ])
    // Another instance's poll won draft-2 between this one's read and its write.
    draftUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    expect(await healStuckApprovedTelegramDrafts()).toBe(1)

    // One audit event, for draft-1 only — a bulk update could not tell the two apart.
    expect(auditCreate).toHaveBeenCalledTimes(1)
    const logged = auditCreate.mock.calls[0][0] as { data: { detail: string; eventType: string } }
    expect(logged.data.eventType).toBe('DRAFT_CONFIRM_RECOVERED')
    expect(logged.data.detail).toContain('draft-1')
  })

  it('does nothing when no draft is stranded', async () => {
    draftFindMany.mockResolvedValue([])

    expect(await healStuckApprovedTelegramDrafts()).toBe(0)
    expect(draftUpdateMany).not.toHaveBeenCalled()
  })
})
