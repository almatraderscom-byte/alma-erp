import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { resolveProfileImageForUser } from '@/lib/user-display'
import { lockStalePendingTelegramDrafts } from '@/lib/trading-telegram-lock'

const LIVE_EVENT_TYPES = [
  'DUPLICATE_TRADE',
  'DUPLICATE_SAVED',
  'DUPLICATE_CANCELLED',
  'UNDO',
  'INVALID_FORMAT',
  'FEE_MISSING',
] as const

export async function getTelegramLiveFeed(opts: { since?: Date; limit?: number }) {
  const limit = Math.min(opts.limit ?? 40, 60)
  await lockStalePendingTelegramDrafts()

  const since = opts.since

  const [drafts, audits, statusCounts] = await Promise.all([
    prisma.tradingTelegramDraft.findMany({
      where: {
        businessId: TRADING_BUSINESS_ID,
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      select: {
        id: true,
        status: true,
        tradeNumber: true,
        tradeType: true,
        usdtAmount: true,
        bdtRate: true,
        feeUsdt: true,
        accountTitle: true,
        accountAlias: true,
        telegramUsername: true,
        telegramUserId: true,
        draftFingerprint: true,
        rawMessage: true,
        createdAt: true,
        user: { select: { id: true, name: true, profileImageUrl: true, updatedAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.tradingTelegramAuditLog.findMany({
      where: {
        businessId: TRADING_BUSINESS_ID,
        eventType: { in: [...LIVE_EVENT_TYPES] },
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      select: {
        id: true,
        eventType: true,
        telegramUserId: true,
        telegramUsername: true,
        rawMessage: true,
        detail: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.tradingTelegramDraft.groupBy({
      by: ['status'],
      where: { businessId: TRADING_BUSINESS_ID },
      _count: { _all: true },
    }),
  ])

  const counts = {
    pending: 0,
    locked: 0,
    rejected: 0,
    posted: 0,
    undone: 0,
  }
  for (const row of statusCounts) {
    if (row.status === 'PENDING') counts.pending = row._count._all
    else if (row.status === 'LOCKED') counts.locked = row._count._all
    else if (row.status === 'REJECTED') counts.rejected = row._count._all
    else if (row.status === 'POSTED') counts.posted = row._count._all
    else if (row.status === 'UNDONE') counts.undone = row._count._all
  }

  const draftsWithAvatars = drafts.map(d => ({
    ...d,
    user: d.user
      ? { ...d.user, profileImageUrl: resolveProfileImageForUser(d.user) }
      : null,
  }))

  return {
    drafts: draftsWithAvatars,
    audits,
    counts,
    serverTime: new Date().toISOString(),
  }
}
