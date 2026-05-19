import type { TradingTelegramDraft, TradingTelegramDraftStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  type TradingContext,
} from '@/lib/trading'

export function canUseTelegramDraftReview(ctx: TradingContext): boolean {
  return ctx.role !== 'VIEWER'
}

export function canManageTelegramConfig(ctx: TradingContext): boolean {
  return ctx.isAdmin
}

export function canViewTelegramMonitor(ctx: TradingContext): boolean {
  return ctx.isAdmin
}

export function canReopenLockedDraft(ctx: TradingContext): boolean {
  return ctx.isAdmin
}

export async function loadDraftForActor(
  ctx: TradingContext,
  draftId: string,
): Promise<
  TradingTelegramDraft & {
    tradingAccount: { id: string; assignedUserId: string | null } | null
  }
> {
  const draft = await prisma.tradingTelegramDraft.findFirst({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID },
    include: {
      tradingAccount: { select: { id: true, assignedUserId: true } },
    },
  })
  if (!draft) throw new Error('Draft not found')

  if (!ctx.isAdmin && draft.userId !== ctx.userId) {
    throw new Error('You can only access your own Telegram drafts')
  }

  if (draft.tradingAccount && !canAccessTradingAccount(ctx, draft.tradingAccount)) {
    throw new Error('This trading account is not assigned to you')
  }

  return draft
}

export function draftListWhereForActor(
  ctx: TradingContext,
  filters: {
    status?: TradingTelegramDraftStatus | 'ALL'
    userId?: string
    tradingAccountId?: string
  },
) {
  const scopedUserId = ctx.isAdmin ? filters.userId : ctx.userId

  return {
    businessId: TRADING_BUSINESS_ID,
    ...(filters.status === 'ALL' || !filters.status ? {} : { status: filters.status }),
    ...(scopedUserId ? { userId: scopedUserId } : {}),
    ...(filters.tradingAccountId ? { tradingAccountId: filters.tradingAccountId } : {}),
  }
}

export async function filterDraftIdsForActor(ctx: TradingContext, draftIds: string[]): Promise<string[]> {
  if (ctx.isAdmin) return draftIds
  const rows = await prisma.tradingTelegramDraft.findMany({
    where: {
      id: { in: draftIds },
      businessId: TRADING_BUSINESS_ID,
      userId: ctx.userId,
    },
    select: { id: true },
  })
  return rows.map(r => r.id)
}
