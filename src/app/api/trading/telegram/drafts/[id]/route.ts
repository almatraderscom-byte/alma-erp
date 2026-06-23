import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  canReopenLockedDraft,
  canUseTelegramDraftReview,
  loadDraftForActor,
} from '@/lib/trading-telegram-permissions'
import { logTelegramDraftAudit } from '@/lib/trading-telegram-draft-audit'
import { getTradingContext, requireTradingWrite } from '@/lib/trading'
import {
  approveTelegramDraftToLedger,
  rejectTelegramDraftRecord,
  updateTelegramDraft,
} from '@/lib/trading-telegram-drafts'
import { reopenLockedTelegramDraft } from '@/lib/trading-telegram-lock'
import { createApprovalRequest, recordSelfApproval } from '@/lib/approvals'
import { TRADING_BUSINESS_ID, canAccessTradingAccount } from '@/lib/trading'
import { commitTradeDeletion } from '@/lib/trading-delete'
import { queueTradingDeleteRequestAlert } from '@/lib/telegram-notification/trading-ops-alerts'

type RouteContext = { params: { id: string } }

export async function GET(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  if (!canUseTelegramDraftReview(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const draft = await loadDraftForActor(ctx, params.id)
    const full = await prisma.tradingTelegramDraft.findFirst({
      where: { id: draft.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        tradingAccount: { select: { id: true, accountTitle: true } },
      },
    })
    if (!full) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    return NextResponse.json({ draft: full })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 })
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied
  if (!canUseTelegramDraftReview(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json()) as {
    action?: 'approve' | 'reject' | 'edit' | 'reopen' | 'request_delete'
    reason?: string
    tradingAccountId?: string
    accountAlias?: string
    tradeType?: 'BUY' | 'SELL'
    usdtAmount?: number
    bdtRate?: number
    feeUsdt?: number
    deleteReason?: string
  }

  try {
    if (body.action === 'reopen') {
      if (!canReopenLockedDraft(ctx)) {
        return NextResponse.json({ error: 'Only admins can reopen locked drafts' }, { status: 403 })
      }
      const draft = await reopenLockedTelegramDraft(params.id, ctx.userId)
      await logTelegramDraftAudit({
        eventType: 'DRAFT_REOPENED',
        draftId: params.id,
        actorUserId: ctx.userId,
        telegramUserId: draft.telegramUserId,
        telegramChatId: draft.telegramChatId,
      })
      return NextResponse.json({ ok: true, draft })
    }

    if (body.action === 'request_delete') {
      const draft = await loadDraftForActor(ctx, params.id)
      if (draft.status !== 'POSTED' || !draft.tradingTradeId) {
        return NextResponse.json({ error: 'Only posted drafts can request ledger delete' }, { status: 400 })
      }
      const trade = await prisma.tradingTrade.findFirst({
        where: { id: draft.tradingTradeId, businessId: TRADING_BUSINESS_ID },
        include: {
          tradingAccount: { select: { id: true, accountTitle: true, assignedUserId: true } },
        },
      })
      if (!trade) return NextResponse.json({ error: 'Linked trade not found' }, { status: 404 })
      if (!canAccessTradingAccount(ctx, trade.tradingAccount)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const reason = String(body.deleteReason || body.reason || '').trim()
      if (!reason) return NextResponse.json({ error: 'Delete reason required' }, { status: 400 })
      if (trade.deleteReason && !trade.deleteApprovedAt) {
        return NextResponse.json({ error: 'Delete request already pending' }, { status: 400 })
      }

      // Super Admin delete is final — execute immediately, skip the approval queue.
      if (ctx.role === 'SUPER_ADMIN') {
        const result = await commitTradeDeletion({
          tradeId: trade.id,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          reason,
        })
        await recordSelfApproval({
          module: 'ALMA_TRADING',
          type: 'TRADE_DELETE',
          businessId: TRADING_BUSINESS_ID,
          entityId: trade.id,
          requestedBy: ctx.userId,
          reason,
          priority: 'HIGH',
          actionUrl: `/trading/accounts/${trade.tradingAccountId}`,
          payloadSnapshot: { tradeId: trade.id, draftId: draft.id },
        })
        await logTelegramDraftAudit({
          eventType: 'DRAFT_DELETE_REQUESTED',
          draftId: draft.id,
          actorUserId: ctx.userId,
          telegramUserId: draft.telegramUserId,
          telegramChatId: draft.telegramChatId,
          detail: `tradeId=${trade.id}; self-approved (Super Admin); ${reason}`,
        })
        return NextResponse.json({ ok: true, selfApproved: true, tradeId: trade.id, ...result })
      }

      await prisma.tradingTrade.update({
        where: { id: trade.id },
        data: { deleteReason: reason, deletedBy: ctx.userId },
      })
      await createApprovalRequest({
        module: 'ALMA_TRADING',
        type: 'TRADE_DELETE',
        businessId: TRADING_BUSINESS_ID,
        entityId: trade.id,
        requestedBy: ctx.userId,
        reason,
        priority: 'HIGH',
        actionUrl: `/trading/accounts/${trade.tradingAccountId}`,
        title: 'Trading delete approval required',
        message: `${trade.tradingAccount.accountTitle}: delete requested from Telegram draft review.`,
        payloadSnapshot: { tradeId: trade.id, draftId: draft.id },
      })
      await logTelegramDraftAudit({
        eventType: 'DRAFT_DELETE_REQUESTED',
        draftId: draft.id,
        actorUserId: ctx.userId,
        telegramUserId: draft.telegramUserId,
        telegramChatId: draft.telegramChatId,
        detail: `tradeId=${trade.id}; ${reason}`,
      })
      const actor = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } })
      await queueTradingDeleteRequestAlert({
        businessId: TRADING_BUSINESS_ID,
        accountTitle: trade.tradingAccount.accountTitle,
        requesterUserId: ctx.userId,
        requesterName: actor?.name || 'Staff',
        reason,
        approvalPath: `/approvals`,
        entityId: trade.id,
      })
      return NextResponse.json({ ok: true, tradeId: trade.id })
    }

    if (body.action === 'edit') {
      let accountTitle: string | null | undefined
      if (body.tradingAccountId) {
        const acc = await prisma.tradingAccount.findFirst({
          where: { id: body.tradingAccountId, deletedAt: null },
          select: { accountTitle: true, assignedUserId: true },
        })
        if (!acc) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
        if (!canAccessTradingAccount(ctx, { assignedUserId: acc.assignedUserId })) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        accountTitle = acc.accountTitle
      }
      const draft = await updateTelegramDraft(ctx, params.id, {
        tradingAccountId: body.tradingAccountId,
        accountAlias: body.accountAlias,
        accountTitle,
        tradeType: body.tradeType,
        usdtAmount: body.usdtAmount,
        bdtRate: body.bdtRate,
        feeUsdt: body.feeUsdt,
      })
      return NextResponse.json({ ok: true, draft })
    }

    if (body.action === 'reject') {
      const draft = await rejectTelegramDraftRecord(
        ctx,
        params.id,
        String(body.reason || 'Rejected'),
      )
      return NextResponse.json({ ok: true, draft })
    }

    if (body.action === 'approve') {
      const result = await approveTelegramDraftToLedger(ctx, params.id)
      const draft = await prisma.tradingTelegramDraft.findUnique({ where: { id: params.id } })
      return NextResponse.json({ ok: true, draft, ...result })
    }

    return NextResponse.json({ error: 'action must be approve, reject, edit, reopen, or request_delete' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
