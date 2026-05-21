import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { normalizeAlmaRole } from '@/lib/roles'
import { serverPost } from '@/lib/server-api'
import { mirrorSalaryAdvanceToSheets } from '@/lib/payroll-sheets-mirror'
import { dispatchApprovalsUpdated, notifyApprovalResolved, resolveApprovalRequest, resolveApprovalRequestById } from '@/lib/approvals'
import {
  approvalMatchesResolvedWalletAction,
  reconcilePenaltyApprovalWithSource,
  reconcileWalletApprovalWithSource,
} from '@/lib/approval-integrity'
import { APPROVAL_TYPES } from '@/lib/approval-types'
import { canReviewPenaltyAppeals, penaltyAppealDto, reviewPenaltyAppeal } from '@/lib/penalty-appeal'
import { logEvent } from '@/lib/logger'
import {
  buildApprovalActionMeta,
  logApprovalActionPhase,
  stampApprovalActionResponse,
} from '@/lib/approval-action-server'
import { apiDataSuccess, apiFailure, classifyApprovalTxError } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { deferAfterApprovalCommit, runApprovalTransaction } from '@/lib/prisma-transaction'
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

export const GET = withApiRoute('approvals.detail', async (req: NextRequest, routeCtx?: unknown) => {
  const { params } = (routeCtx ?? {}) as RouteContext
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })

  const approval = await prisma.approvalRequest.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      status: true,
      module: true,
      type: true,
      updatedAt: true,
      approvedAt: true,
      rejectedAt: true,
    },
  })
  if (!approval) {
    return apiFailure('approval_not_found', 'Approval not found', { status: 404 })
  }
  return apiDataSuccess({ approval })
})

export const PATCH = withApiRoute('approvals.action', async (req: NextRequest, routeCtx?: unknown) => {
  const { params } = (routeCtx ?? {}) as RouteContext
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
  const role = normalizeAlmaRole(token.role as string)

  const body = await req.json().catch(() => ({})) as {
    action?: 'APPROVE' | 'REJECT'
    note?: string
    approvedAmount?: number
    operation_id?: string
  }
  if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
    return NextResponse.json({ error: 'action APPROVE|REJECT required' }, { status: 400 })
  }

  const meta = buildApprovalActionMeta({
    approvalId: params.id,
    adminId: token.sub,
    action: body.action,
    operationId: body.operation_id,
  })
  logApprovalActionPhase('started', meta)
  logApprovalActionPhase('processing', meta)

  try {
    const approval = await prisma.approvalRequest.findUnique({ where: { id: params.id } })
    if (!approval) {
      logEvent('warn', 'approval.pending.lookup_failed', {
        approvalId: params.id,
        actualStatus: 'missing',
        adminId: token.sub,
        action: body.action,
        requestId: req.headers.get('x-request-id') || undefined,
      })
      return stampApprovalActionResponse(
        approvalErrorResponse('Approval not found', 404, 'approval_not_found'),
        meta,
      )
    }
    if (approval.status !== 'PENDING') {
      const requestedTerminal = body.action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      // Idempotent replay: same admin clicks twice, stale list still shows
      // PENDING, double-tap on mobile, etc. Return success without re-running
      // the module side effects so we don't double-spend wallet ledger entries
      // or re-fire Telegram pushes.
      if (approval.status === requestedTerminal) {
        logEvent('info', 'approval.action.idempotent_replay', {
          approvalId: params.id,
          status: approval.status,
          action: body.action,
          module: approval.module,
          type: approval.type,
          adminId: token.sub,
          requestId: req.headers.get('x-request-id') || undefined,
        })
        return stampApprovalActionResponse(
          apiDataSuccess({ approval, moduleResult: null, alreadyApplied: true }),
          meta,
        )
      }
      // Mismatched terminal state — operator likely has a stale view; surface
      // it so they refresh.
      logEvent('warn', 'approval.pending.lookup_failed', {
        approvalId: params.id,
        actualStatus: approval.status,
        module: approval.module,
        type: approval.type,
        adminId: token.sub,
        action: body.action,
        requestId: req.headers.get('x-request-id') || undefined,
      })
      return stampApprovalActionResponse(
        approvalErrorResponse(
          `Approval is already ${approval.status}; cannot ${body.action}.`,
          409,
          'approval_already_resolved',
        ),
        meta,
      )
    }

    const isPenaltyAppeal = approval.module === 'PAYROLL' && approval.type === APPROVAL_TYPES.PENALTY_APPEAL
    if (!isPenaltyAppeal && role !== 'SUPER_ADMIN') {
      return stampApprovalActionResponse(
        approvalErrorResponse('Only Super Admin can process this approval type.', 403, 'forbidden'),
        meta,
      )
    }
    if (isPenaltyAppeal && !canReviewPenaltyAppeals(role)) {
      return stampApprovalActionResponse(
        approvalErrorResponse('Only Admin or Super Admin can process penalty appeals.', 403, 'forbidden'),
        meta,
      )
    }

    let response: NextResponse
    if (isPenaltyAppeal) {
      response = await processPenaltyAppeal(approval, body.action, token.sub, body.note, body.approvedAmount)
    } else if (approval.module === 'ALMA_TRADING' && approval.type === 'TRADE_DELETE') {
      response = await processTradingDelete(approval.id, approval.entityId, body.action, token.sub, role, body.note)
    } else if (approval.module === 'PAYROLL' && approval.type === 'SALARY_ADVANCE') {
      response = await processSalaryAdvance(req, approval.id, approval.entityId, body.action, token.sub, String(token.name || token.email || 'Super Admin'), body.note)
    } else if (approval.module === 'PAYROLL' && (approval.type === 'WALLET_WITHDRAWAL' || approval.type === 'WALLET_ADVANCE')) {
      response = await processWalletRequest(approval.id, approval.entityId, body.action, token.sub, body.note, body.approvedAmount)
    } else if (body.action === 'REJECT') {
      const updated = await resolveApprovalRequestById({ id: approval.id, status: 'REJECTED', actorUserId: token.sub, reason: body.note || 'Rejected' })
      response = apiDataSuccess({ approval: updated, moduleResult: null })
    } else {
      response = approvalErrorResponse(
        `${approval.module} ${approval.type} is not executable from the central approval center yet.`,
        400,
        'not_executable',
      )
    }
    return stampApprovalActionResponse(response, meta)
  } catch (e) {
    const classified = classifyApprovalTxError(e)
    logEvent('error', 'approval.execute_failed', {
      approvalId: params.id,
      error: classified.error,
      message: classified.message,
    })
    return stampApprovalActionResponse(
      apiFailure(classified.error, classified.message, {
        status: classified.error.includes('timeout') || classified.error.includes('pool') ? 503 : 500,
        rolledBack: classified.rolledBack,
        extra: { code: classified.error },
      }),
      meta,
    )
  }
})

function approvalErrorResponse(
  message: string,
  status: number,
  code?: string,
  extra?: Record<string, unknown>,
) {
  return apiFailure(code || 'approval_failed', message, { status, extra })
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

  const waiver = await prisma.attendanceWaiverRequest.findFirst({
    where: { id: approval.entityId, businessId: approval.businessId },
  })
  if (!waiver) {
    const closed = await resolveApprovalRequestById({
      id: approval.id,
      status: 'REJECTED',
      actorUserId,
      reason: note?.slice(0, 500) || 'Linked waiver request missing — approval auto-closed',
    })
    dispatchApprovalsUpdated()
    return NextResponse.json({
      ok: true,
      approval: closed,
      moduleResult: null,
      reconciled: true,
      warning: 'Source waiver was missing; approval closed to prevent orphan queue items.',
    })
  }

  if (waiver.status !== 'PENDING') {
    const target =
      waiver.status === 'REJECTED' || waiver.status === 'CANCELLED'
        ? 'REJECTED'
        : waiver.status === 'APPROVED' || waiver.status === 'PARTIALLY_APPROVED'
          ? 'APPROVED'
          : null
    if (
      target
      && ((action === 'REJECT' && target === 'REJECTED') || (action === 'APPROVE' && target === 'APPROVED'))
    ) {
      const reconciled = await reconcilePenaltyApprovalWithSource({
        approvalId: approval.id,
        waiverStatus: waiver.status,
        actorUserId,
        note,
      })
      if (reconciled.ok) {
        dispatchApprovalsUpdated()
        return apiDataSuccess({ ...reconciled, moduleResult: { waiver: penaltyAppealDto(waiver) } })
      }
    }
    return NextResponse.json(
      {
        error: `Penalty appeal is already ${waiver.status}. It may have been processed from Attendance. Refresh approvals.`,
        code: 'SOURCE_ALREADY_RESOLVED',
        sourceStatus: waiver.status,
      },
      { status: 409 },
    )
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
    return apiDataSuccess({ approval, moduleResult: { trade: updatedTrade } })
  }

  const result = await runApprovalTransaction('approval.trading_delete', async tx => {
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
  })
  const approval = await resolveApprovalRequestById({ id: approvalId, status: 'APPROVED', actorUserId, reason: note || trade.deleteReason || 'Approved' })
  return apiDataSuccess({ approval, moduleResult: result })
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
    return apiDataSuccess({ approval, moduleResult: { advance: updated } })
  }

  const empId = adv.user.employeeIdGas?.trim()
  if (!empId) return NextResponse.json({ error: 'User has no linked HR employee id - link profile first.' }, { status: 400 })

  // Phase 1: Postgres is the source of truth. Update the salary advance row
  // and resolve the approval BEFORE we attempt to mirror the row into the
  // legacy Google Sheets payroll book. A Sheets failure no longer rolls back
  // the DB write — `mirrorSalaryAdvanceToSheets` captures the failure to
  // Sentry so operators can re-push from the admin payroll tools.
  const updated = await prisma.salaryAdvanceRequest.update({
    where: { id: adv.id },
    data: { status: 'APPROVED', reviewedById: actorUserId, reviewedAt: new Date(), reviewNote: note?.slice(0, 500) || null },
  })
  const approval = await resolveApprovalRequestById({ id: approvalId, status: 'APPROVED', actorUserId, reason: note || 'Approved' })

  const actorPayload = await mergeActorPayload(req, {})
  const mirror = await mirrorSalaryAdvanceToSheets({
    advanceId: adv.id,
    approvalId,
    businessId: adv.businessId,
    empId,
    amount: Number(adv.amount),
    reason: adv.reason,
    requestedBy: adv.user.name || adv.user.email || adv.userId,
    approvedBy: actorName,
    note,
    actorPayload,
  })

  return apiDataSuccess({
    approval,
    moduleResult: {
      advance: updated,
      gas: mirror.ok ? mirror.gas : null,
      sheetsMirrored: mirror.ok,
      sheetsError: mirror.ok ? undefined : mirror.error,
    },
    ...(mirror.ok ? {} : {
      warning:
        'Salary advance approved in ERP. Mirror to payroll Sheets failed — re-push from admin payroll tools.',
    }),
  })
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
  if (!request) {
    logEvent('error', 'approval.entity.missing', { approvalId, entityId: requestId, module: 'PAYROLL' })
    const approval = await resolveApprovalRequestById({
      id: approvalId,
      status: 'REJECTED',
      actorUserId,
      reason: note?.slice(0, 500) || 'Linked wallet request missing — approval auto-closed',
    })
    dispatchApprovalsUpdated()
    return NextResponse.json({
      ok: true,
      approval,
      moduleResult: null,
      reconciled: true,
      warning: 'Source wallet request was missing; approval closed to prevent orphan queue items.',
    })
  }

  if (request.status !== 'PENDING') {
    if (approvalMatchesResolvedWalletAction(action, request.status)) {
      const reconciled = await reconcileWalletApprovalWithSource({
        approvalId,
        wallet: request,
        action,
        actorUserId,
        note,
      })
      if (!reconciled.ok) {
        logEvent('warn', 'approval.reject.failed', { approvalId, reason: reconciled.error, walletStatus: request.status })
        return NextResponse.json({ error: reconciled.error, code: 'SOURCE_ALREADY_RESOLVED' }, { status: 409 })
      }
      dispatchApprovalsUpdated()
      return NextResponse.json(reconciled)
    }
    logEvent('warn', 'approval.lookup.failed', {
      approvalId,
      entityId: requestId,
      walletStatus: request.status,
      action,
    })
    return NextResponse.json(
      {
        error: `Wallet request is already ${request.status}. It was likely processed from Payroll. Refresh approvals.`,
        code: 'SOURCE_ALREADY_RESOLVED',
        sourceStatus: request.status,
      },
      { status: 409 },
    )
  }

  if (action === 'REJECT') {
    let result: { updated: typeof request; approval: NonNullable<Awaited<ReturnType<typeof resolveApprovalRequest>>> }
    try {
      result = await runApprovalTransaction('approval.wallet_reject', async tx => {
      const updated = await tx.walletRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          reviewNote: note?.slice(0, 500) || null,
          reviewedById: actorUserId,
          reviewedAt: new Date(),
        },
      })
      const approval = await resolveApprovalRequest({
        module: 'PAYROLL',
        type: request.type === 'WITHDRAWAL' ? 'WALLET_WITHDRAWAL' : 'WALLET_ADVANCE',
        entityId: request.id,
        status: 'REJECTED',
        actorUserId,
        reason: note?.slice(0, 500) || 'Rejected',
        tx,
      })
      if (!approval) {
        throw new Error('LINKAGE_BROKEN: pending approval row missing for wallet request')
      }
      return { updated, approval }
    })
    } catch (e) {
      const classified = classifyApprovalTxError(e)
      return approvalErrorResponse(classified.message, 503, classified.error, { rolledBack: classified.rolledBack })
    }
    logEvent('info', 'approval.reject.success', { approvalId, entityId: requestId, module: 'PAYROLL' })
    if (result.approval) {
      deferAfterApprovalCommit('approval.center.wallet_reject_notify', async () => {
        await notifyApprovalResolved(result.approval!, actorUserId, 'REJECTED', note?.slice(0, 500) || 'Rejected')
      })
    }
    dispatchApprovalsUpdated()
    return apiDataSuccess({ approval: result.approval, moduleResult: { request: result.updated } })
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
  let result: {
    entry: Awaited<ReturnType<typeof prisma.employeeLedgerEntry.create>>
    request: typeof request
    approval: NonNullable<Awaited<ReturnType<typeof resolveApprovalRequest>>>
  }
  try {
    result = await runApprovalTransaction('approval.wallet_approve', async tx => {
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
    const approval = await resolveApprovalRequest({
      module: 'PAYROLL',
      type: request.type === 'WITHDRAWAL' ? 'WALLET_WITHDRAWAL' : 'WALLET_ADVANCE',
      entityId: request.id,
      status: 'APPROVED',
      actorUserId,
      reason: note?.slice(0, 500) || 'Approved',
      tx,
    })
    if (!approval) {
      throw new Error('LINKAGE_BROKEN: pending approval row missing for wallet request')
    }
    return { entry, request: updated, approval }
  })
  } catch (e) {
    const classified = classifyApprovalTxError(e)
    return approvalErrorResponse(classified.message, 503, classified.error, { rolledBack: classified.rolledBack })
  }
  logEvent('info', 'approval.approve.success', { approvalId, entityId: requestId, module: 'PAYROLL' })
  if (result.approval) {
    deferAfterApprovalCommit('approval.center.wallet_approve_notify', async () => {
      await notifyApprovalResolved(result.approval!, actorUserId, 'APPROVED', note?.slice(0, 500) || 'Approved')
    })
  }
  dispatchApprovalsUpdated()
  return apiDataSuccess({ approval: result.approval, moduleResult: { entry: result.entry, request: result.request } })
}
