import type { TradingTradeType, TradingTelegramDraftStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { logTelegramDraftAudit } from '@/lib/trading-telegram-draft-audit'
import { assertDraftEditable, lockStalePendingTelegramDrafts } from '@/lib/trading-telegram-lock'
import {
  draftListWhereForActor,
  filterDraftIdsForActor,
  loadDraftForActor,
} from '@/lib/trading-telegram-permissions'
import type { TradingContext } from '@/lib/trading'
import { createTradingTradeRecord } from '@/lib/trading-trade-create'
import { resolveProfileImageForUser } from '@/lib/user-display'

export type UpdateTelegramDraftInput = {
  tradingAccountId?: string
  accountAlias?: string | null
  accountTitle?: string | null
  tradeType?: TradingTradeType
  usdtAmount?: number
  bdtRate?: number
  feeUsdt?: number
}

export type ListTelegramDraftsOptions = {
  status: TradingTelegramDraftStatus | 'ALL'
  limit: number
  userId?: string
  tradingAccountId?: string
  duplicateOnly?: boolean
  ctx: TradingContext
}

export async function updateTelegramDraft(
  ctx: TradingContext,
  draftId: string,
  input: UpdateTelegramDraftInput,
) {
  const draft = await loadDraftForActor(ctx, draftId)
  assertDraftEditable(draft.status)

  const updated = await prisma.tradingTelegramDraft.update({
    where: { id: draftId },
    data: {
      ...(input.tradingAccountId !== undefined ? { tradingAccountId: input.tradingAccountId } : {}),
      ...(input.accountAlias !== undefined ? { accountAlias: input.accountAlias } : {}),
      ...(input.accountTitle !== undefined ? { accountTitle: input.accountTitle } : {}),
      ...(input.tradeType !== undefined ? { tradeType: input.tradeType } : {}),
      ...(input.usdtAmount !== undefined ? { usdtAmount: input.usdtAmount } : {}),
      ...(input.bdtRate !== undefined ? { bdtRate: input.bdtRate } : {}),
      ...(input.feeUsdt !== undefined ? { feeUsdt: input.feeUsdt } : {}),
      lastEditedBy: ctx.userId,
      lastEditedAt: new Date(),
    },
    include: {
      user: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
      tradingAccount: { select: { id: true, accountTitle: true } },
    },
  })

  await logTelegramDraftAudit({
    eventType: 'DRAFT_EDITED',
    draftId,
    actorUserId: ctx.userId,
    telegramUserId: draft.telegramUserId,
    telegramChatId: draft.telegramChatId,
  })

  return updated
}

export async function postDraftToLedger(draftId: string, reviewerUserId: string) {
  const draft = await prisma.tradingTelegramDraft.findFirst({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID },
  })
  if (!draft) throw new Error('Draft not found')
  assertDraftEditable(draft.status)
  if (!draft.userId || !draft.tradingAccountId || !draft.tradeType) {
    throw new Error('Draft is incomplete — edit account and trade fields first')
  }
  if (draft.status === 'POSTED' && draft.tradingTradeId) {
    return { tradeId: draft.tradingTradeId, alreadyPosted: true }
  }

  const notes = [
    `Telegram @${draft.telegramUsername || draft.telegramUserId}`,
    `Raw: ${draft.rawMessage}`,
  ].join('\n')

  const { trade } = await createTradingTradeRecord({
    tradingAccountId: draft.tradingAccountId,
    userId: draft.userId,
    tradeType: draft.tradeType,
    usdtAmount: Number(draft.usdtAmount),
    bdtRate: Number(draft.bdtRate),
    feeUsdt: Number(draft.feeUsdt ?? 0),
    notes,
    actorUserId: reviewerUserId,
  })

  await prisma.tradingTelegramDraft.update({
    where: { id: draft.id },
    data: {
      status: 'POSTED',
      tradingTradeId: trade.id,
      postedAt: new Date(),
      reviewedBy: reviewerUserId,
      reviewedAt: new Date(),
    },
  })

  return { tradeId: trade.id, alreadyPosted: false }
}

export async function approveTelegramDraftToLedger(ctx: TradingContext, draftId: string) {
  const draft = await loadDraftForActor(ctx, draftId)
  assertDraftEditable(draft.status)

  await prisma.tradingTelegramDraft.updateMany({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID, status: 'PENDING' },
    data: { status: 'APPROVED', reviewedBy: ctx.userId, reviewedAt: new Date() },
  })
  const result = await postDraftToLedger(draftId, ctx.userId)
  await logTelegramDraftAudit({
    eventType: 'DRAFT_CONFIRMED',
    draftId,
    actorUserId: ctx.userId,
    telegramUserId: draft.telegramUserId,
    telegramChatId: draft.telegramChatId,
    detail: result.tradeId ? `tradeId=${result.tradeId}` : undefined,
  })
  return result
}

export async function rejectTelegramDraftRecord(ctx: TradingContext, draftId: string, reason: string) {
  const draft = await loadDraftForActor(ctx, draftId)
  if (draft.status === 'POSTED') throw new Error('Cannot reject a posted draft')
  if (draft.status === 'LOCKED' && !ctx.isAdmin) {
    throw new Error('Locked drafts can only be rejected by an admin — ask admin to reopen first')
  }

  const updated = await prisma.tradingTelegramDraft.update({
    where: { id: draftId },
    data: {
      status: 'REJECTED',
      rejectReason: reason,
      reviewedBy: ctx.userId,
      reviewedAt: new Date(),
    },
  })

  await logTelegramDraftAudit({
    eventType: 'DRAFT_REJECTED',
    draftId,
    actorUserId: ctx.userId,
    telegramUserId: draft.telegramUserId,
    telegramChatId: draft.telegramChatId,
    detail: reason,
  })

  return updated
}

export async function bulkApproveTelegramDrafts(ctx: TradingContext, draftIds: string[]) {
  const allowed = await filterDraftIdsForActor(ctx, draftIds)
  const results: Array<{ id: string; ok: boolean; tradeId?: string; error?: string }> = []
  for (const id of allowed) {
    try {
      const r = await approveTelegramDraftToLedger(ctx, id)
      results.push({ id, ok: true, tradeId: r.tradeId })
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message })
    }
  }
  return results
}

export async function bulkRejectTelegramDrafts(ctx: TradingContext, draftIds: string[], reason: string) {
  const allowed = await filterDraftIdsForActor(ctx, draftIds)
  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const id of allowed) {
    try {
      await rejectTelegramDraftRecord(ctx, id, reason)
      results.push({ id, ok: true })
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message })
    }
  }
  return results
}

export async function listTelegramDrafts(opts: ListTelegramDraftsOptions) {
  await lockStalePendingTelegramDrafts()

  const drafts = await prisma.tradingTelegramDraft.findMany({
    where: draftListWhereForActor(opts.ctx, {
      status: opts.status,
      userId: opts.userId,
      tradingAccountId: opts.tradingAccountId,
    }),
    include: {
      user: { select: { id: true, name: true, email: true, profileImageUrl: true, updatedAt: true } },
      tradingAccount: { select: { id: true, accountTitle: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: opts.limit,
  })

  const withAvatars = enrichDraftUsers(drafts)
  if (!opts.duplicateOnly) return withAvatars

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000)
  const recent = await prisma.tradingTelegramDraft.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      draftFingerprint: { not: null },
      createdAt: { gte: since },
    },
    select: { draftFingerprint: true, telegramUserId: true },
    take: 500,
  })
  const counts = new Map<string, number>()
  for (const r of recent) {
    const k = `${r.telegramUserId}:${r.draftFingerprint}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const dupKeys = new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k))
  return withAvatars.filter(d => d.draftFingerprint && dupKeys.has(`${d.telegramUserId}:${d.draftFingerprint}`))
}

function enrichDraftUsers<T extends { user: { id: string; profileImageUrl: string | null; updatedAt: Date } | null }>(drafts: T[]) {
  return drafts.map(draft => {
    if (!draft.user) return draft
    return {
      ...draft,
      user: {
        ...draft.user,
        profileImageUrl: resolveProfileImageForUser(draft.user),
      },
    }
  })
}
