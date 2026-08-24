import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner decision 2026-08-24: keep the day-cutoff lock, but stop it ambushing
 * staff who confirm their drafts in a batch when they are free. Two warnings —
 * the evening before, and an hour ahead of the cutoff.
 */

const draftFindMany = vi.fn()
const auditFindFirst = vi.fn()
const auditCreate = vi.fn()
const sendTelegramMessage = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tradingTelegramDraft: { findMany: (...a: unknown[]) => draftFindMany(...a) },
    tradingTelegramAuditLog: {
      findFirst: (...a: unknown[]) => auditFindFirst(...a),
      create: (...a: unknown[]) => auditCreate(...a),
    },
  },
}))

vi.mock('@/lib/trading-telegram-bot', () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}))

import {
  collectPendingConfirmGroups,
  confirmNudgeUrgencyForNow,
  sendPendingConfirmNudges,
} from '@/lib/trading-telegram-confirm-nudge'

function pending(overrides: Record<string, unknown> = {}) {
  return {
    telegramUserId: '7921737198',
    telegramChatId: '-5157095212',
    telegramUsername: 'Hossainmuqtadir',
    usdtAmount: 127.67,
    createdAt: new Date('2026-08-23T16:35:00.000Z'),
    user: { name: 'Hossain Muqtadir' },
    ...overrides,
  }
}

describe('collectPendingConfirmGroups', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rolls a staffer\'s drafts into one message, not one per draft', async () => {
    draftFindMany.mockResolvedValue([pending(), pending(), pending({ usdtAmount: 10 })])

    const groups = await collectPendingConfirmGroups('EVENING')

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(groups[0].totalUsdt).toBeCloseTo(265.34, 2)
    expect(groups[0].staffName).toBe('Hossain Muqtadir')
  })

  it('separates staff who share the group chat', async () => {
    draftFindMany.mockResolvedValue([
      pending(),
      pending({ telegramUserId: '8709318313', telegramUsername: 'Akterpoli', user: { name: 'Poly Akter' } }),
    ])

    const groups = await collectPendingConfirmGroups('EVENING')

    expect(groups.map(g => g.staffName).sort()).toEqual(['Hossain Muqtadir', 'Poly Akter'])
  })

  it('the final warning looks only at drafts already past the day boundary', async () => {
    draftFindMany.mockResolvedValue([])

    await collectPendingConfirmGroups('FINAL')
    const finalWhere = (draftFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(finalWhere.createdAt).toBeDefined()

    await collectPendingConfirmGroups('EVENING')
    const eveningWhere = (draftFindMany.mock.calls[1][0] as { where: Record<string, unknown> }).where
    // Today's rows cross the boundary at midnight, so the evening warning covers
    // everything still open.
    expect(eveningWhere.createdAt).toBeUndefined()
  })
})

describe('sendPendingConfirmNudges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auditFindFirst.mockResolvedValue(null)
    auditCreate.mockResolvedValue({})
    sendTelegramMessage.mockResolvedValue({ ok: true })
    draftFindMany.mockResolvedValue([pending(), pending()])
  })

  it('messages the chat the drafts came from and records the warning', async () => {
    const result = await sendPendingConfirmNudges('FINAL')

    expect(result).toMatchObject({ groups: 1, sent: 1, skipped: 0 })
    const [chatId, text] = sendTelegramMessage.mock.calls[0]
    expect(chatId).toBe('-5157095212')
    expect(String(text)).toContain('@Hossainmuqtadir')
    expect(String(text)).toContain('2')          // two unconfirmed
    expect(auditCreate).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the same staffer was warned minutes ago', async () => {
    auditFindFirst.mockResolvedValue({ id: 'nudge-1' })

    const result = await sendPendingConfirmNudges('FINAL')

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('scopes the cooldown to the chat, so a second group still gets warned', async () => {
    draftFindMany.mockResolvedValue([pending(), pending({ telegramChatId: '-999' })])

    await sendPendingConfirmNudges('FINAL')

    // One staffer, two chats → two independent cooldown lookups.
    expect(auditFindFirst).toHaveBeenCalledTimes(2)
    const chats = auditFindFirst.mock.calls.map(
      c => (c[0] as { where: { telegramChatId: string } }).where.telegramChatId,
    )
    expect(chats.sort()).toEqual(['-5157095212', '-999'])
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2)
  })

  it('does not record a warning Telegram refused to deliver', async () => {
    sendTelegramMessage.mockResolvedValue({ ok: false, errorMessage: 'chat not found' })

    const result = await sendPendingConfirmNudges('EVENING')

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    expect(auditCreate).not.toHaveBeenCalled()
  })
})

describe('confirmNudgeUrgencyForNow', () => {
  afterEach(() => { delete process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD })

  /** tradingBdNow() returns a UTC-shifted Date whose UTC hour IS the Dhaka hour. */
  const atDhakaHour = (h: number) => new Date(Date.UTC(2026, 7, 24, h, 0, 0))

  it('warns in the evening and again an hour before the cutoff', () => {
    expect(confirmNudgeUrgencyForNow(atDhakaHour(23))).toBe('EVENING')
    expect(confirmNudgeUrgencyForNow(atDhakaHour(5))).toBe('FINAL')
  })

  it('stays silent at every other hour', () => {
    for (const h of [0, 6, 9, 14, 18, 22]) {
      expect(confirmNudgeUrgencyForNow(atDhakaHour(h))).toBeNull()
    }
  })

  it('follows the cutoff hour when the owner moves it', () => {
    // Only safe because the cron fires hourly and this picks the window — two
    // pinned UTC schedules would still fire at 05:00 and miss the new one.
    process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD = '12'
    expect(confirmNudgeUrgencyForNow(atDhakaHour(11))).toBe('FINAL')
    expect(confirmNudgeUrgencyForNow(atDhakaHour(5))).toBeNull()
  })
})
