import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner decision 2026-08-24: keep the day-cutoff lock, but stop it ambushing
 * staff who confirm their drafts in a batch when they are free. Two warnings —
 * the evening before, and an hour ahead of the cutoff.
 */

const draftFindMany = vi.fn()
const auditFindFirst = vi.fn()
const auditCreate = vi.fn()
const auditDelete = vi.fn()
const auditDeleteMany = vi.fn()
const auditUpdate = vi.fn()
const sendTelegramMessage = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tradingTelegramDraft: { findMany: (...a: unknown[]) => draftFindMany(...a) },
    tradingTelegramAuditLog: {
      findFirst: (...a: unknown[]) => auditFindFirst(...a),
      create: (...a: unknown[]) => auditCreate(...a),
      delete: (...a: unknown[]) => auditDelete(...a),
      deleteMany: (...a: unknown[]) => auditDeleteMany(...a),
      update: (...a: unknown[]) => auditUpdate(...a),
    },
  },
}))

vi.mock('@/lib/trading-telegram-bot', () => ({
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}))

import { tradingBdDayBounds } from '@/lib/trading-compliance'
import {
  collectPendingConfirmGroups,
  confirmNudgeUrgencyForNow,
  sendPendingConfirmNudges,
} from '@/lib/trading-telegram-confirm-nudge'

let pendingSeq = 0
function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: `draft-${pendingSeq += 1}`,
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
    auditCreate.mockResolvedValue({ id: 'claim-1' })
    auditDelete.mockResolvedValue({})
    auditDeleteMany.mockResolvedValue({ count: 0 })
    auditUpdate.mockResolvedValue({})
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
    // Reserved as SENDING, then marked delivered so the lease cannot reclaim it.
    expect(String((auditCreate.mock.calls[0][0] as { data: { detail: string } }).data.detail))
      .toContain('SENDING')
    expect(String((auditUpdate.mock.calls[0][0] as { data: { detail: string } }).data.detail))
      .not.toContain('SENDING')
  })

  it('reclaims a reservation abandoned mid-send instead of suppressing the day', async () => {
    await sendPendingConfirmNudges('FINAL')

    // Without this, a crash between the insert and the send leaves the
    // deterministic id sitting there and no later run can ever take it.
    const where = (auditDeleteMany.mock.calls[0][0] as {
      where: { detail: { startsWith: string }; createdAt: { lt: Date } }
    }).where
    expect(where.detail.startsWith).toContain('SENDING')
    expect(where.createdAt.lt).toBeInstanceOf(Date)
  })

  it('stays quiet when the same staffer was warned minutes ago', async () => {
    auditFindFirst.mockResolvedValue({ id: 'nudge-1' })

    const result = await sendPendingConfirmNudges('FINAL')

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('reclaims the abandoned lease BEFORE reading the cooldown', async () => {
    auditFindFirst.mockResolvedValue({ id: 'nudge-1' })   // the abandoned row itself

    await sendPendingConfirmNudges('FINAL')

    // Ordered after the cooldown read, the early return fired first and the
    // lease never ran — leaving the day suppressed by a warning never sent.
    expect(auditDeleteMany).toHaveBeenCalled()
    expect(auditDeleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(auditFindFirst.mock.invocationCallOrder[0])
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

  it('scopes the cooldown by urgency, so the evening warning cannot eat the final one', async () => {
    // With TELEGRAM_DRAFT_LOCK_HOUR_BD between 1 and 4 the FINAL run lands inside
    // the 4-hour cooldown started at 23:00 — the message that matters most.
    await sendPendingConfirmNudges('FINAL')

    const where = (auditFindFirst.mock.calls[0][0] as { where: { detail: unknown } }).where
    expect(where.detail).toEqual({ startsWith: 'FINAL' })
  })

  it('reserves on a deterministic key so a losing run does not send', async () => {
    auditCreate.mockRejectedValue(new Error('duplicate key'))

    const result = await sendPendingConfirmNudges('FINAL')

    // The insert IS the reservation: losing it means another run owns this
    // warning, so this one must stay quiet.
    expect(sendTelegramMessage).not.toHaveBeenCalled()
    expect(result).toMatchObject({ sent: 0, skipped: 1 })
  })

  it('keys the reservation by urgency, chat, staffer and DAY', async () => {
    await sendPendingConfirmNudges('FINAL')

    const id = (auditCreate.mock.calls[0][0] as { data: { id: string } }).data.id
    // Per-day, not per-hour: the final warning spans a short window, and an
    // hour key would let the same warning go out twice inside it.
    expect(id).toMatch(/^nudge:FINAL:-5157095212:7921737198:\d{4}-\d{2}-\d{2}$/)
  })

  it('pages through every pending draft, not just the first batch', async () => {
    const page = Array.from({ length: 500 }, () => pending())
    draftFindMany.mockResolvedValueOnce(page).mockResolvedValueOnce([pending()])

    await sendPendingConfirmNudges('FINAL')

    // A full page must trigger another read — a flat take silently dropped every
    // staffer whose drafts sat past it.
    expect(draftFindMany).toHaveBeenCalledTimes(2)
    const second = draftFindMany.mock.calls[1][0] as { cursor?: unknown; skip?: number }
    expect(second.cursor).toBeDefined()
    expect(second.skip).toBe(1)
  })

  it('names the real deadline when the cutoff is midnight', async () => {
    vi.clearAllMocks()
    process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD = '0'
    auditFindFirst.mockResolvedValue(null)
    auditCreate.mockResolvedValue({ id: 'claim-1' })
    sendTelegramMessage.mockResolvedValue({ ok: true })
    draftFindMany.mockResolvedValue([pending()])

    await sendPendingConfirmNudges('FINAL')

    const text = String(sendTelegramMessage.mock.calls[0][1])
    // "আজ ভোর 0টায়" would name a time 23 hours in the past.
    expect(text).not.toMatch(/ভোর 0টায়/)
    expect(text).toContain('রাত ১২টায়')
    delete process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD
  })

  it('claims the cooldown before calling Telegram, not after', async () => {
    const order: string[] = []
    auditCreate.mockImplementation(async () => { order.push('claim'); return { id: 'claim-1' } })
    sendTelegramMessage.mockImplementation(async () => { order.push('send'); return { ok: true } })

    await sendPendingConfirmNudges('FINAL')

    // Check-then-send let an overlapping run pass the check before either wrote
    // its row, and staff got the reminder twice.
    expect(order).toEqual(['claim', 'send'])
  })

  it('releases the claim when Telegram refuses, so the next run retries', async () => {
    sendTelegramMessage.mockResolvedValue({ ok: false, errorMessage: 'chat not found' })

    const result = await sendPendingConfirmNudges('EVENING')

    expect(result).toMatchObject({ sent: 0, skipped: 1 })
    // Released under the same deterministic key it was reserved with.
    const deleted = (auditDelete.mock.calls[0][0] as { where: { id: string } }).where.id
    expect(deleted).toMatch(/^nudge:EVENING:-5157095212:7921737198:/)
  })
})

describe('confirmNudgeUrgencyForNow', () => {
  afterEach(() => { delete process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD })

  /** tradingBdNow() returns a UTC-shifted Date whose UTC hour IS the Dhaka hour. */
  const atDhakaHour = (h: number) => new Date(Date.UTC(2026, 7, 24, h, 0, 0))

  it('warns in the evening and exactly one hour before the cutoff', () => {
    expect(confirmNudgeUrgencyForNow(atDhakaHour(23))).toBe('EVENING')
    expect(confirmNudgeUrgencyForNow(atDhakaHour(5))).toBe('FINAL')
    // NOT two hours out: an earlier eligible run would deliver, take the day's
    // reservation, and the real one-hour warning would never fire.
    expect(confirmNudgeUrgencyForNow(atDhakaHour(4))).toBeNull()
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

  it('a midnight cutoff warns about today\'s drafts too, not just yesterday\'s', async () => {
    vi.clearAllMocks()          // this describe has no beforeEach of its own
    process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD = '0'
    draftFindMany.mockResolvedValue([])

    await collectPendingConfirmGroups('FINAL')

    // At 23:00 the midnight cutoff is an hour away and it will take TODAY's rows.
    // A `< todayStart` filter would have warned about an empty set.
    const where = (draftFindMany.mock.calls[0][0] as { where: { createdAt?: { lt: Date } } }).where
    const { end: tomorrowStart } = tradingBdDayBounds()
    expect(where.createdAt?.lt.getTime()).toBe(tomorrowStart.getTime())
    delete process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD
  })

  it('wraps to the previous evening when the cutoff is midnight', () => {
    // telegramDraftLockHourBd accepts 0. Clamping to hour 0 would have warned
    // when the cutoff was already active and the sweep may have locked the rows.
    process.env.TELEGRAM_DRAFT_LOCK_HOUR_BD = '0'
    expect(confirmNudgeUrgencyForNow(atDhakaHour(23))).toBe('FINAL')
    expect(confirmNudgeUrgencyForNow(atDhakaHour(0))).toBeNull()
  })
})
