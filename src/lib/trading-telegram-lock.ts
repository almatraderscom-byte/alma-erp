import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { telegramDraftLockHourBd, tradingBdDayBounds, tradingBdNow } from '@/lib/trading-compliance'

/** Lock PENDING drafts from before today's BD day once past cutoff hour. Idempotent. */
export async function lockStalePendingTelegramDrafts(): Promise<number> {
  const now = tradingBdNow()
  if (now.getUTCHours() < telegramDraftLockHourBd()) return 0

  const { start: todayStart } = tradingBdDayBounds(now)
  const reason = `Auto-locked after BD ${telegramDraftLockHourBd()}:00 cutoff`

  const result = await prisma.tradingTelegramDraft.updateMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      status: 'PENDING',
      createdAt: { lt: todayStart },
    },
    data: {
      status: 'LOCKED',
      lockedAt: new Date(),
      lockedReason: reason,
    },
  })

  return result.count
}

export async function reopenLockedTelegramDraft(draftId: string, reviewerUserId: string) {
  const draft = await prisma.tradingTelegramDraft.findFirst({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID, status: 'LOCKED' },
  })
  if (!draft) throw new Error('Draft not found or not locked')

  return prisma.tradingTelegramDraft.update({
    where: { id: draftId },
    data: {
      status: 'PENDING',
      lockedAt: null,
      lockedReason: null,
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
      tradingAccount: { select: { id: true, accountTitle: true } },
    },
  })
}

export function assertDraftEditable(status: string): void {
  if (status === 'LOCKED') {
    throw new Error('Draft is locked — reopen in ERP admin before editing or confirming')
  }
  if (status === 'POSTED') {
    throw new Error('Draft already posted to ledger')
  }
  if (status === 'REJECTED') {
    throw new Error('Draft was rejected')
  }
}
