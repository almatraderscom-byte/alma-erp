import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { normalizeAlmaRole } from '@/lib/roles'
import { serverPost } from '@/lib/server-api'
import { dispatchApprovalsUpdated, resolveApprovalRequestById } from '@/lib/approvals'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import { canReviewPenaltyAppeals, reviewPenaltyAppeal } from '@/lib/penalty-appeal'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  recalculateTradingAccount,
  refreshTradingDailySnapshot,
} from '@/lib/trading'
import {
  computeWalletSummary,
  entryTypeForRequest,
  moneyDecimal,
  requestStatusFromApproval,
} from '@/lib/payroll-wallet'

type RouteContext = { params: { id: string } }

type AuditEntry = {
  action: 'DELETE_APPROVED' | 'DELETE_REJECTED'
  actorUserId: string
  actorRole: string
  reason: string
  timestamp: string
  before?: Record<string, unknown>
}

function appendTradeHistory(value: unknown, entry: AuditEntry): Prisma.InputJsonValue {
  const rows = Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : []
  return [...rows, entry] as Prisma.InputJsonValue
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

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)

  const body = await req.json().catch(() => ({})) as {
    action?: 'APPROVE' | 'REJECT'
    note?: string
    approvedAmount?: number
  }
  if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
    return NextResponse.json({ error: 'action APPROVE|REJECT required' }, { status: 400 })
  }

  try {
    const approval = await prisma.approvalRequest.findUnique({ where: { id: params.id } })
    if (!approval || approval.status !== 'PENDING') {
      return NextResponse.json({ error: 'Pending approval not found' }, { status: 404 })
    }

    const isPenaltyAppeal = approval.module === 'PAYROLL' && approval.type === APPROVAL_TYPES.PENALTY_APPEAL
    if (!isPenaltyAppeal && role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admin can process this approval type.' }, { status: 403 })
    }
    if (isPenaltyAppeal && !canReviewPenaltyAppeals(role)) {
      return NextResponse.json({ error: 'Only Admin or Super Admin can process penalty appeals.' }, { status: 403 })
    }

    if (isPenaltyAppeal) {
      return await processPenaltyAppeal(approval, body.action, token.sub, body.note, body.approvedAmount)
    }

    if (approval.module === 'ALMA_TRADING' && approval.type === 'TRADE_DELETE') {
      return await processTradingDelete(approval.id, approval.entityId, body.action, token.sub, role, body.note)
    }
    if (approval.module === 'PAYROLL' && approval.type === 'SALARY_ADVANCE') {
      return await processSalaryAdvance(req, approval.id, approval.entityId, body.action, token.sub, String(token.name || token.email || 'Super Admin'), body.note)
    }
    if (approval.module === 'PAYROLL' && (approval.type === 'WALLET_WITHDRAWAL' || approval.type === 'WALLET_ADVANCE')) {
      return await processWalletRequest(approval.id, approval.entityId, body.action, token.sub, body.note, body.approvedAmount)
    }

    if (body.action === 'REJECT') {
      const updated = await resolveApprovalRequestById({ id: approval.id, status: 'REJECTED', actorUserId: token.sub, reason: body.note || 'Rejected' })
      return NextResponse.json({ ok: true, approval: updated, moduleResult: null })
    }
    return NextResponse.json({ error: `${approval.module} ${approval.type} is not executable from the central approval center yet.` }, { status: 400 })
  } catch (e) {
    logEvent('error', 'approval.execute_failed', { approvalId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

async function processPenaltyAppeal(
  approval: { id: string; entityId: string; businessId: string | null },
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  note?: string,
  approvedAmountInput?: number,
) {
  if (!approval.businessId) {
    return NextResponse.json({ error: 'Penalty appeal approval is missing business scope.' }, { status: 400 })
  }

  const result = await reviewPenaltyAppeal({
    waiverId: approval.entityId,
    businessId: approval.businessId,
    actorUserId,
    action: action === 'REJECT' ? 'REJECT' : 'APPROVE',
    approvedReductionAmount: approvedAmountInput,
    adminNote: note,
    source: 'erp',
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  const approvalRow = await prisma.approvalRequest.findUnique({ where: { id: approval.id } })
  dispatchApprovalsUpdated()
  return NextResponse.json({
    ok: true,
    approval: approvalRow,
    moduleResult: { waiver: result.waiver, alreadyReviewed: 'alreadyReviewed' in result ? result.alreadyReviewed : false },
  })
}

async function processTradingDelete(
  approvalId: string,
  tradeId: string,
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  actorRole: string,
  note?: string,
) {
  const trade = await prisma.tradingTrade.findFirst({ where: { id: tradeId, businessId: TRADING_BUSINESS_ID } })
  if (!trade || !trade.deleteReason || trade.deletedAt) {
    return NextResponse.json({ error: 'Pending trade delete request not found' }, { status: 400 })
  }
  if (action === 'REJECT') {
    const updatedTrade = await prisma.tradingTrade.update({
      where: { id: trade.id },
      data: {
        deleteReason: null,
        deletedBy: null,
        editHistory: appendTradeHistory(trade.editHistory, {
          action: 'DELETE_REJECTED',
          actorUserId,
          actorRole,
          reason: note || 'Rejected from central approval center',
          timestamp: new Date().toISOString(),
          before: { requestedBy: trade.deletedBy, deleteReason: trade.deleteReason },
        }),
      },
    })
    const approval = await resolveApprovalRequestById({ id: approvalId, status: 'REJECTED', actorUserId, reason: note || 'Rejected' })
    return NextResponse.json({ ok: true, approval, moduleResult: { trade: updatedTrade } })
  }

  const result = await prisma.$transaction(async tx => {
    const now = new Date()
    const updatedTrade = await tx.tradingTrade.update({
      where: { id: trade.id },
      data: {
        deletedAt: now,
        deleteApprovedBy: actorUserId,
        deleteApprovedAt: now,
        editHistory: appendTradeHistory(trade.editHistory, {
          action: 'DELETE_APPROVED',
          actorUserId,
          actorRole,
          reason: trade.deleteReason || note || 'Approved from central approval center',
          timestamp: now.toISOString(),
          before: tradeSnapshot(trade),
        }),
      },
    })
    const summary = await recalculateTradingAccount(tx, trade.tradingAccountId)
    await refreshTradingDailySnapshot(tx, trade.tradingAccountId, trade.tradeDate, summary)
    return { trade: updatedTrade, summary }
  }, { maxWait: 10_000, timeout: 20_000 })
  const approval = await resolveApprovalRequestById({ id: approvalId, status: 'APPROVED', actorUserId, reason: note || trade.deleteReason || 'Approved' })
  return NextResponse.json({ ok: true, approval, moduleResult: result })
}

async function processSalaryAdvance(
  req: NextRequest,
  approvalId: string,
  requestId: string,
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  actorName: string,
  note?: string,
) {
  const adv = await prisma.salaryAdvanceRequest.findUnique({ where: { id: requestId }, include: { user: true } })
  if (!adv || adv.status !== 'PENDING') return NextResponse.json({ error: 'Pending salary advance not found' }, { status: 400 })

  if (action === 'REJECT') {
    const updated = await prisma.salaryAdvanceRequest.update({
      where: { id: adv.id },
      data: { status: 'REJECTED', reviewedById: actorUserId, reviewedAt: new Date(), reviewNote: note?.slice(0, 500) || null },
    })
    const approval = await resolveApprovalRequestById({ id: approvalId, status: 'REJECTED', actorUserId, reason: note || 'Rejected' })
    return NextResponse.json({ ok: true, approval, moduleResult: { advance: updated } })
  }

  const empId = adv.user.employeeIdGas?.trim()
  if (!empId) return NextResponse.json({ error: 'User has no linked HR employee id - link profile first.' }, { status: 400 })
  const payrollPayload = await mergeActorPayload(req, {
    emp_id: empId,
    business_id: adv.businessId,
    tx_type: 'advance',
    amount: Number(adv.amount),
    advance_reason: adv.reason,
    requested_by: adv.user.name || adv.user.email || adv.userId,
    approved_by: actorName,
    note: note?.slice(0, 400) || '',
  })
  const gas = await serverPost('hr_payroll_add', payrollPayload)
  const updated = await prisma.salaryAdvanceRequest.update({
    where: { id: adv.id },
    data: { status: 'APPROVED', reviewedById: actorUserId, reviewedAt: new Date(), reviewNote: note?.slice(0, 500) || null },
  })
  const approval = await resolveApprovalRequestById({ id: approvalId, status: 'APPROVED', actorUserId, reason: note || 'Approved' })
  return NextResponse.json({ ok: true, approval, moduleResult: { advance: updated, gas } })
}

async function processWalletRequest(
  approvalId: string,
  requestId: string,
  action: 'APPROVE' | 'REJECT',
  actorUserId: string,
  note?: string,
  approvedAmountInput?: number,
) {
  const request = await prisma.walletRequest.findUnique({ where: { id: requestId } })
  if (!request || request.status !== 'PENDING') return NextResponse.json({ error: 'Pending wallet request not found' }, { status: 400 })

  if (action === 'REJECT') {
    const updated = await prisma.walletRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED', reviewNote: note?.slice(0, 500) || null, reviewedById: actorUserId, reviewedAt: new Date() },
    })
    const approval = await resolveApprovalRequestById({ id: approvalId, status: 'REJECTED', actorUserId, reason: note || 'Rejected' })
    return NextResponse.json({ ok: true, approval, moduleResult: { request: updated } })
  }

  const requestedAmount = Number(request.requestedAmount)
  const approvedAmount = Number(approvedAmountInput || requestedAmount)
  if (!approvedAmount || approvedAmount <= 0 || approvedAmount > requestedAmount) {
    return NextResponse.json({ error: 'approvedAmount must be > 0 and <= requested amount' }, { status: 400 })
  }
  if (request.type === 'WITHDRAWAL') {
    const entries = await prisma.employeeLedgerEntry.findMany({ where: { employeeId: request.employeeId, businessId: request.businessId } })
    const balance = computeWalletSummary(request.employeeId, request.businessId, entries).availableWithdrawable
    if (approvedAmount > balance) return NextResponse.json({ error: `Insufficient wallet balance. Available: ${balance}` }, { status: 400 })
  }
  const result = await prisma.$transaction(async tx => {
    const entry = await tx.employeeLedgerEntry.create({
      data: {
        employeeId: request.employeeId,
        userId: request.userId,
        businessId: request.businessId,
        date: new Date(),
        type: entryTypeForRequest(request.type),
        amount: moneyDecimal(approvedAmount),
        note: note?.slice(0, 500) || request.reason,
        createdById: request.userId,
        approvedById: actorUserId,
        source: 'wallet_request',
        sourceRef: request.id,
        walletRequestId: request.id,
      },
    })
    const updated = await tx.walletRequest.update({
      where: { id: request.id },
      data: {
        status: requestStatusFromApproval(requestedAmount, approvedAmount),
        approvedAmount: moneyDecimal(approvedAmount),
        reviewNote: note?.slice(0, 500) || null,
        reviewedById: actorUserId,
        reviewedAt: new Date(),
        ledgerEntryId: entry.id,
      },
    })
    return { entry, request: updated }
  })
  const approval = await resolveApprovalRequestById({ id: approvalId, status: 'APPROVED', actorUserId, reason: note || 'Approved' })
  return NextResponse.json({ ok: true, approval, moduleResult: result })
}
