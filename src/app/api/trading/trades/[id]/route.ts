import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { createApprovalRequest, resolveApprovalRequest } from '@/lib/approvals'
import {
  TRADING_BUSINESS_ID,
  canAccessTradingAccount,
  getTradingContext,
  isResponse,
  moneyDecimal,
  nonNegativeUsdtDecimal,
  parseTradingDate,
  parseTradeType,
  positiveRateDecimal,
  positiveUsdtDecimal,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
  requireTradingWrite,
  tradingOperationCalculations,
} from '@/lib/trading'
import { queueTradingDeleteRequestAlert } from '@/lib/telegram-notification/trading-ops-alerts'

type RouteContext = { params: { id: string } }

type AuditEntry = {
  action: 'EDITED' | 'DELETE_REQUESTED' | 'DELETE_APPROVED' | 'DELETE_REJECTED'
  actorUserId: string
  actorRole: string
  reason: string
  timestamp: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

function historyRows(value: unknown): AuditEntry[] {
  return Array.isArray(value) ? value.filter(row => row && typeof row === 'object') as AuditEntry[] : []
}

function appendHistory(value: unknown, entry: AuditEntry): Prisma.InputJsonValue {
  return [...historyRows(value), entry] as Prisma.InputJsonValue
}

function tradeSnapshot(trade: {
  tradeType: unknown
  usdtAmount: unknown
  bdtRate: unknown
  feeUsdt: unknown
  netBdt: unknown
  netProfit: unknown
  tradeDate: Date
  notes: string | null
}) {
  return {
    tradeType: String(trade.tradeType),
    usdtAmount: Number(trade.usdtAmount),
    bdtRate: Number(trade.bdtRate),
    feeUsdt: Number(trade.feeUsdt),
    netBdt: Number(trade.netBdt),
    netProfit: Number(trade.netProfit),
    tradeDate: trade.tradeDate.toISOString(),
    notes: trade.notes,
  }
}

function requireReason(value: unknown, label: string) {
  const reason = String(value || '').trim()
  if (reason.length < 5) {
    return NextResponse.json({ error: `${label} reason must be at least 5 characters` }, { status: 400 })
  }
  return reason
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied

  try {
    const body = await req.json() as {
      action?: 'edit' | 'request_delete' | 'approve_delete' | 'reject_delete'
      tradeType?: string
      usdtAmount?: number
      bdtRate?: number
      feeUsdt?: number
      tradeDate?: string
      notes?: string
      editReason?: string
      deleteReason?: string
      rejectionReason?: string
    }
    const action = body.action || 'edit'
    const trade = await prisma.tradingTrade.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID },
      include: {
        tradingAccount: { select: { id: true, accountTitle: true, assignedUserId: true, usdtBalance: true, inventoryCostBdt: true } },
      },
    })
    if (!trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 })
    if (!canAccessTradingAccount(ctx, trade.tradingAccount)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (action === 'request_delete') {
      if (trade.deletedAt) return NextResponse.json({ error: 'Trade is already deleted' }, { status: 400 })
      if (trade.deleteReason && !trade.deleteApprovedAt) return NextResponse.json({ error: 'Delete request is already pending' }, { status: 400 })
      const reason = requireReason(body.deleteReason, 'Delete')
      if (isResponse(reason)) return reason
      const updated = await prisma.tradingTrade.update({
        where: { id: trade.id },
        data: {
          deleteReason: reason,
          deletedBy: ctx.userId,
          editHistory: appendHistory(trade.editHistory, {
            action: 'DELETE_REQUESTED',
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            reason,
            timestamp: new Date().toISOString(),
            before: tradeSnapshot(trade),
          }),
        },
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
        message: `${trade.tradingAccount.accountTitle}: a trade delete was requested. Reason: ${reason}`,
        payloadSnapshot: {
          trade: tradeSnapshot(trade),
          accountId: trade.tradingAccountId,
          accountTitle: trade.tradingAccount.accountTitle,
        },
      })
      logEvent('warn', 'trading.trade.delete_requested', { tradeId: trade.id, accountId: trade.tradingAccountId, actorUserId: ctx.userId, reason })
      const actor = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } })
      await queueTradingDeleteRequestAlert({
        businessId: TRADING_BUSINESS_ID,
        accountTitle: trade.tradingAccount.accountTitle,
        requesterUserId: ctx.userId,
        requesterName: actor?.name || ctx.userId,
        reason,
        approvalPath: `/approvals`,
        entityId: trade.id,
      })
      return NextResponse.json({ ok: true, trade: updated })
    }

    if (action === 'reject_delete') {
      if (ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Only Super Admin can reject delete requests' }, { status: 403 })
      if (!trade.deleteReason || trade.deletedAt) return NextResponse.json({ error: 'No pending delete request found' }, { status: 400 })
      const reason = requireReason(body.rejectionReason, 'Rejection')
      if (isResponse(reason)) return reason
      const updated = await prisma.tradingTrade.update({
        where: { id: trade.id },
        data: {
          deleteReason: null,
          deletedBy: null,
          editHistory: appendHistory(trade.editHistory, {
            action: 'DELETE_REJECTED',
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            reason,
            timestamp: new Date().toISOString(),
            before: { requestedBy: trade.deletedBy, deleteReason: trade.deleteReason },
          }),
        },
      })
      await resolveApprovalRequest({
        module: 'ALMA_TRADING',
        type: 'TRADE_DELETE',
        entityId: trade.id,
        status: 'REJECTED',
        actorUserId: ctx.userId,
        reason,
      })
      logEvent('info', 'trading.trade.delete_rejected', { tradeId: trade.id, accountId: trade.tradingAccountId, actorUserId: ctx.userId })
      return NextResponse.json({ ok: true, trade: updated })
    }

    if (action === 'approve_delete') {
      if (ctx.role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Only Super Admin can approve deletes' }, { status: 403 })
      if (!trade.deleteReason || trade.deletedAt) return NextResponse.json({ error: 'No pending delete request found' }, { status: 400 })
      const result = await prisma.$transaction(async tx => {
        const now = new Date()
        const updated = await tx.tradingTrade.update({
          where: { id: trade.id },
          data: {
            deletedAt: now,
            deleteApprovedBy: ctx.userId,
            deleteApprovedAt: now,
            editHistory: appendHistory(trade.editHistory, {
              action: 'DELETE_APPROVED',
              actorUserId: ctx.userId,
              actorRole: ctx.role,
              reason: trade.deleteReason || 'Delete approved',
              timestamp: now.toISOString(),
              before: tradeSnapshot(trade),
            }),
          },
        })
        const summary = await recalculateTradingAccount(tx, trade.tradingAccountId)
        await refreshTradingDailySnapshot(tx, trade.tradingAccountId, trade.tradeDate, summary)
        return { trade: updated, summary }
      }, { maxWait: 10_000, timeout: 20_000 })
      await resolveApprovalRequest({
        module: 'ALMA_TRADING',
        type: 'TRADE_DELETE',
        entityId: trade.id,
        status: 'APPROVED',
        actorUserId: ctx.userId,
        reason: trade.deleteReason || 'Delete approved',
      })
      logEvent('warn', 'trading.trade.delete_approved', { tradeId: trade.id, accountId: trade.tradingAccountId, actorUserId: ctx.userId })
      return NextResponse.json({ ok: true, ...result })
    }

    if (trade.deletedAt) return NextResponse.json({ error: 'Deleted trades cannot be edited' }, { status: 400 })
    if (trade.deleteReason && !trade.deleteApprovedAt) return NextResponse.json({ error: 'Trade has a pending delete request. Reject it before editing.' }, { status: 400 })
    const editReason = requireReason(body.editReason, 'Edit')
    if (isResponse(editReason)) return editReason
    const tradeType = parseTradeType(body.tradeType ?? trade.tradeType)
    if (isResponse(tradeType)) return tradeType
    const usdtAmount = positiveUsdtDecimal(body.usdtAmount ?? trade.usdtAmount, 'usdtAmount')
    if (isResponse(usdtAmount)) return usdtAmount
    const bdtRate = positiveRateDecimal(body.bdtRate ?? trade.bdtRate, 'bdtRate')
    if (isResponse(bdtRate)) return bdtRate
    const feeUsdt = nonNegativeUsdtDecimal(body.feeUsdt ?? trade.feeUsdt, 'feeUsdt')
    if (isResponse(feeUsdt)) return feeUsdt
    const tradeDate = parseTradingDate(body.tradeDate ?? trade.tradeDate, 'tradeDate')
    if (isResponse(tradeDate)) return tradeDate

    const result = await prisma.$transaction(async tx => {
      const currentAccount = await tx.tradingAccount.findUniqueOrThrow({
        where: { id: trade.tradingAccountId },
        select: { usdtBalance: true, inventoryCostBdt: true },
      })
      const oldUsdtDelta = trade.tradeType === 'BUY' ? Number(trade.usdtAmount) : -Number(trade.usdtAmount)
      const oldInventoryDelta = trade.tradeType === 'BUY' ? Number(trade.costBasisBdt) : -Number(trade.costBasisBdt)
      const baseUsdt = Number(currentAccount.usdtBalance) - oldUsdtDelta
      const baseInventoryCost = Number(currentAccount.inventoryCostBdt) - oldInventoryDelta
      if (tradeType === 'SELL' && baseUsdt + 0.00000001 < Number(usdtAmount)) {
        return {
          error: NextResponse.json({ error: 'Edited SELL exceeds available USDT after removing the original trade.' }, { status: 400 }),
        }
      }
      const averageCostRateBdt = tradeType === 'SELL' && baseUsdt > 0
        ? moneyDecimal(baseInventoryCost / baseUsdt)
        : moneyDecimal(0)
      const calc = tradingOperationCalculations({ tradeType, usdtAmount, bdtRate, feeUsdt, averageCostRateBdt })
      const before = tradeSnapshot(trade)
      const updated = await tx.tradingTrade.update({
        where: { id: trade.id },
        data: {
          tradeType,
          usdtAmount,
          bdtRate,
          buyRateBdt: tradeType === 'BUY' ? bdtRate : averageCostRateBdt,
          sellRateBdt: tradeType === 'SELL' ? bdtRate : moneyDecimal(0),
          totalBdt: calc.totalBdt,
          netBdt: calc.netBdt,
          costBasisBdt: calc.costBasisBdt,
          buyAmount: calc.buyAmount,
          sellAmount: calc.sellAmount,
          feeUsdt,
          feeBdt: calc.feeBdt,
          feeAmount: calc.feeBdt,
          netProfit: calc.netProfitBdt,
          tradeDate,
          notes: String(body.notes ?? trade.notes ?? '').trim() || null,
          updatedBy: ctx.userId,
          editHistory: appendHistory(trade.editHistory, {
            action: 'EDITED',
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            reason: editReason,
            timestamp: new Date().toISOString(),
            before,
            after: {
              tradeType,
              usdtAmount: Number(usdtAmount),
              bdtRate: Number(bdtRate),
              feeUsdt: Number(feeUsdt),
              tradeDate: tradeDate.toISOString(),
              notes: String(body.notes ?? trade.notes ?? '').trim() || null,
            },
          }),
        },
      })
      const summary = await recalculateTradingAccount(tx, trade.tradingAccountId)
      await refreshTradingDailySnapshot(tx, trade.tradingAccountId, trade.tradeDate, summary)
      if (tradeDate.toDateString() !== trade.tradeDate.toDateString()) {
        await refreshTradingDailySnapshot(tx, trade.tradingAccountId, tradeDate, summary)
      }
      return { trade: updated, summary }
    }, { maxWait: 10_000, timeout: 20_000 })
    if ('error' in result) return result.error

    logEvent('info', 'trading.trade.edited', { tradeId: trade.id, accountId: trade.tradingAccountId, actorUserId: ctx.userId, reason: editReason })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    logEvent('error', 'trading.trade.mutation_failed', { tradeId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
