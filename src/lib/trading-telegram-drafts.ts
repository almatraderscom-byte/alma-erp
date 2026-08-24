import type { TradingTradeType, TradingTelegramDraftStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { logTelegramDraftAudit } from '@/lib/trading-telegram-draft-audit'
import {
  assertDraftEditable,
  recoverStrandedApprovedDraft,
  sweepTelegramDraftStates,
} from '@/lib/trading-telegram-lock'
import {
  draftListWhereForActor,
  filterDraftIdsForActor,
  loadDraftForActor,
} from '@/lib/trading-telegram-permissions'
import type { TradingContext } from '@/lib/trading'
import { createTradingTradeRecord } from '@/lib/trading-trade-create'
import { telegramDraftTradeDate } from '@/lib/trading-compliance'
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

  // Only an UNCLAIMED draft is editable. A claimed one (APPROVED) may already be
  // inside the ledger transaction, which read the old numbers — editing it there
  // would post one set of values and leave the draft showing another. A stranded
  // claim is recovered to PENDING by the sweep first, so this is not a dead end.
  const edited = await prisma.tradingTelegramDraft.updateMany({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID, status: 'PENDING' },
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
      // The numbers just changed — whatever the last confirm complained about is
      // no longer what staff are looking at.
      confirmError: null,
      confirmErrorAt: null,
    },
  })
  if (edited.count === 0) {
    throw new Error('This draft is being confirmed right now — refresh before editing it')
  }

  const updated = await prisma.tradingTelegramDraft.findFirstOrThrow({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID },
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
  // Idempotency FIRST: a second click on an already-posted draft must return the
  // existing trade, not the "already posted to ledger" error assertDraftEditable
  // would throw (which is what made this branch dead code before).
  if (draft.status === 'POSTED' && draft.tradingTradeId) {
    return { tradeId: draft.tradingTradeId, alreadyPosted: true }
  }
  assertDraftEditable(draft.status)
  if (!draft.userId || !draft.tradingAccountId || !draft.tradeType) {
    throw new Error('Draft is incomplete — edit account and trade fields first')
  }

  const notes = [
    `Telegram @${draft.telegramUsername || draft.telegramUserId}`,
    `Raw: ${draft.rawMessage}`,
  ].join('\n')

  // The draft is linked to the trade INSIDE the trade's transaction. Two
  // statements would leave a window where the ledger row exists but the draft
  // still looks unposted — and every recovery path would then post it twice.
  const { trade } = await createTradingTradeRecord({
    tradingAccountId: draft.tradingAccountId,
    userId: draft.userId,
    tradeType: draft.tradeType,
    usdtAmount: Number(draft.usdtAmount),
    bdtRate: Number(draft.bdtRate),
    feeUsdt: Number(draft.feeUsdt ?? 0),
    // The trade happened when the staffer typed it into Telegram, not when
    // someone got around to confirming it. Staff confirm in batches "when free",
    // often the next day — without this the trade lands on the wrong day's P/L
    // and the wrong daily snapshot. Same BD calendar day the drafts list groups
    // it under, so the books match what staff see.
    tradeDate: telegramDraftTradeDate(draft.createdAt),
    notes,
    actorUserId: reviewerUserId,
    linkTelegramDraftId: draft.id,
  })

  return { tradeId: trade.id, alreadyPosted: false }
}

/**
 * Confirm a draft into the ledger.
 *
 * The draft is CLAIMED (PENDING → APPROVED) before the trade is written so two
 * taps can't post twice — but a claim that never reaches the ledger is rolled
 * straight back to PENDING with the reason attached. The old code claimed and
 * never rolled back, which stranded eight production drafts in APPROVED: gone
 * from the pending list, never in the account, no button left to retry.
 */
export async function approveTelegramDraftToLedger(ctx: TradingContext, draftId: string) {
  const draft = await loadDraftForActor(ctx, draftId)
  if (draft.status === 'POSTED' && draft.tradingTradeId) {
    return { tradeId: draft.tradingTradeId, alreadyPosted: true }
  }
  assertDraftEditable(draft.status)

  // A draft stranded by an earlier crash is recovered FIRST, and only once it is
  // old enough to be certain no confirm is still running. Claiming straight out
  // of APPROVED would let two concurrent reviewers both believe they won.
  if (draft.status === 'APPROVED') {
    await recoverStrandedApprovedDraft(draftId)
  }

  // The claim is exclusive: exactly one request can move a draft out of PENDING.
  const claim = await prisma.tradingTelegramDraft.updateMany({
    where: {
      id: draftId,
      businessId: TRADING_BUSINESS_ID,
      status: 'PENDING',
      tradingTradeId: null,
    },
    data: { status: 'APPROVED', reviewedBy: ctx.userId, reviewedAt: new Date() },
  })
  if (claim.count === 0) {
    const now = await prisma.tradingTelegramDraft.findFirst({
      where: { id: draftId, businessId: TRADING_BUSINESS_ID },
      select: { status: true, tradingTradeId: true },
    })
    if (now?.status === 'POSTED' && now.tradingTradeId) {
      return { tradeId: now.tradingTradeId, alreadyPosted: true }
    }
    if (now?.status === 'APPROVED') {
      throw new Error('This draft is being confirmed right now — refresh in a moment')
    }
    throw new Error('Draft is no longer confirmable — refresh and check its status')
  }

  let result: { tradeId: string; alreadyPosted: boolean }
  try {
    result = await postDraftToLedger(draftId, ctx.userId)
  } catch (e) {
    const reason = (e as Error).message
    // Release the claim so the draft stays in the staff's list with the reason
    // on it. Guarded on tradingTradeId so a trade that DID land is never undone.
    await prisma.tradingTelegramDraft.updateMany({
      where: { id: draftId, businessId: TRADING_BUSINESS_ID, status: 'APPROVED', tradingTradeId: null },
      data: { status: 'PENDING', confirmError: reason, confirmErrorAt: new Date() },
    })
    await logTelegramDraftAudit({
      eventType: 'DRAFT_CONFIRM_FAILED',
      draftId,
      actorUserId: ctx.userId,
      telegramUserId: draft.telegramUserId,
      telegramChatId: draft.telegramChatId,
      detail: reason,
    }).catch(() => {})
    throw e
  }

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

  // Same claim rule as the edit path: rejecting a draft whose ledger transaction
  // is mid-flight would race the POSTED write.
  const rejected = await prisma.tradingTelegramDraft.updateMany({
    where: {
      id: draftId,
      businessId: TRADING_BUSINESS_ID,
      status: { in: ['PENDING', 'LOCKED'] },
    },
    data: {
      status: 'REJECTED',
      rejectReason: reason,
      reviewedBy: ctx.userId,
      reviewedAt: new Date(),
      confirmError: null,
      confirmErrorAt: null,
    },
  })
  if (rejected.count === 0) {
    throw new Error('This draft is being confirmed right now — refresh before rejecting it')
  }

  const updated = await prisma.tradingTelegramDraft.findFirstOrThrow({
    where: { id: draftId, businessId: TRADING_BUSINESS_ID },
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

/** Largest batch one request will attempt; the rest come back as `skipped`. */
export const MAX_BULK_CONFIRM = 40
/** Stop starting new posts past this, so the caller always gets a report. */
const BULK_TIME_BUDGET_MS = 90_000

/**
 * Order a batch the way the day actually happened.
 *
 * The client sends whatever order the list was in — which is `createdAt: 'desc'`,
 * so "select all pending" replayed the day BACKWARDS. A SELL then reached the
 * ledger before the BUY that funded it and died on the balance guard. Confirming
 * a day's trades in one go only works oldest-first.
 */
async function orderDraftIdsChronologically(ids: string[]): Promise<string[]> {
  if (ids.length < 2) return ids
  const rows = await prisma.tradingTelegramDraft.findMany({
    where: { id: { in: ids }, businessId: TRADING_BUSINESS_ID },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { tradeNumber: 'asc' }],
  })
  return rows.map(r => r.id)
}

export async function bulkApproveTelegramDrafts(ctx: TradingContext, draftIds: string[]) {
  const allowed = await orderDraftIdsChronologically(await filterDraftIdsForActor(ctx, draftIds))
  const batch = allowed.slice(0, MAX_BULK_CONFIRM)
  const results: Array<{ id: string; ok: boolean; tradeId?: string; error?: string }> = []
  let skipped = allowed.length - batch.length
  const deadline = Date.now() + BULK_TIME_BUDGET_MS

  for (const [index, id] of batch.entries()) {
    // Each post is a transaction plus an account recalc; a long batch can outrun
    // the function. Stop early WITH a report rather than dying mid-loop, which
    // would leave some drafts posted and the reviewer with a network error.
    if (index > 0 && Date.now() > deadline) {
      skipped += batch.length - index
      break
    }
    try {
      const r = await approveTelegramDraftToLedger(ctx, id)
      results.push({ id, ok: true, tradeId: r.tradeId })
    } catch (e) {
      results.push({ id, ok: false, error: (e as Error).message })
    }
  }

  return { results, skipped }
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
  await sweepTelegramDraftStates()

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
