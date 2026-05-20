import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import {
  computeWalletSummary,
  entryTypeForRequest,
  moneyDecimal,
  requestStatusFromApproval,
} from '@/lib/payroll-wallet'
import { notifyUser } from '@/lib/notifications'
import { sendPayrollAlert } from '@/lib/resend'
import { dispatchApprovalsUpdated, notifyApprovalResolved, resolveApprovalRequest } from '@/lib/approvals'
import { logEvent } from '@/lib/logger'
import { deferAfterApprovalCommit, runApprovalTransaction } from '@/lib/prisma-transaction'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = (await req.json()) as {
    action?: 'APPROVE' | 'REJECT'
    approvedAmount?: number
    note?: string
  }
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can review wallet requests.')

  const request = await prisma.walletRequest.findUnique({ where: { id: params.id } })
  if (!request || request.status !== 'PENDING') {
    return NextResponse.json({ error: 'Pending request not found' }, { status: 404 })
  }
  if (!ctx.businessIds.includes(request.businessId as never)) {
    return forbidden('Business not permitted for this request.')
  }

  if (body.action === 'REJECT') {
    const result = await runApprovalTransaction('payroll.wallet_reject', async tx => {
      const updated = await tx.walletRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          reviewNote: body.note?.slice(0, 500) || null,
          reviewedById: ctx.userId,
          reviewedAt: new Date(),
        },
      })
      const approval = await resolveApprovalRequest({
        module: 'PAYROLL',
        type: request.type === 'WITHDRAWAL' ? 'WALLET_WITHDRAWAL' : 'WALLET_ADVANCE',
        entityId: request.id,
        status: 'REJECTED',
        actorUserId: ctx.userId,
        reason: body.note?.slice(0, 500) || 'Rejected',
        tx,
      })
      if (!approval) {
        throw new Error('LINKAGE_BROKEN: pending approval missing for wallet request')
      }
      return { updated, approval }
    }).catch(e => {
      logEvent('error', 'approval.reject.failed', {
        entityId: request.id,
        source: 'payroll_wallet',
        error: (e as Error).message,
      })
      throw e
    })
    const updated = result.updated
    deferAfterApprovalCommit('payroll.wallet_reject_notify', async () => {
      await notifyApprovalResolved(result.approval, ctx.userId, 'REJECTED', body.note?.slice(0, 500) || 'Rejected')
      await notifyUser({
        userId: request.userId,
        businessId: request.businessId,
        type: 'WALLET_REQUEST_REJECTED',
        priority: 'HIGH',
        title: `${request.type} request rejected`,
        message: body.note?.slice(0, 240) || 'Your wallet request was reviewed and rejected.',
        actionUrl: '/portal',
      })
      await sendPayrollAlert({
        businessId: request.businessId,
        subject: `${request.type} request rejected · ${request.employeeId}`,
        title: 'Payroll request rejected',
        preview: body.note || 'A wallet request was rejected.',
        text: `${request.type} request for employee ${request.employeeId} was rejected. ${body.note || ''}`,
        priority: 'HIGH',
        actionUrl: '/payroll',
        actionLabel: 'Open payroll',
        dedupeKey: `wallet-request-rejected:${request.id}`,
        metadata: { requestId: request.id, employeeId: request.employeeId },
      })
    })
    dispatchApprovalsUpdated()
    return NextResponse.json({ ok: true, request: updated, approvalId: result.approval.id })
  }

  if (body.action !== 'APPROVE') {
    return NextResponse.json({ error: 'action APPROVE|REJECT required' }, { status: 400 })
  }

  const requestedAmount = Number(request.requestedAmount)
  const approvedAmount = Number(body.approvedAmount || requestedAmount)
  if (!approvedAmount || approvedAmount <= 0 || approvedAmount > requestedAmount) {
    return NextResponse.json({ error: 'approvedAmount must be > 0 and <= requested amount' }, { status: 400 })
  }

  if (request.type === 'WITHDRAWAL') {
    const entries = await prisma.employeeLedgerEntry.findMany({
      where: { employeeId: request.employeeId, businessId: request.businessId },
    })
    const balance = computeWalletSummary(request.employeeId, request.businessId, entries).availableWithdrawable
    if (approvedAmount > balance) {
      return NextResponse.json({ error: `Insufficient wallet balance. Available: ${balance}` }, { status: 400 })
    }
  }

  const result = await runApprovalTransaction('payroll.wallet_approve', async tx => {
    const entry = await tx.employeeLedgerEntry.create({
      data: {
        employeeId: request.employeeId,
        userId: request.userId,
        businessId: request.businessId,
        date: new Date(),
        type: entryTypeForRequest(request.type),
        amount: moneyDecimal(approvedAmount),
        note: body.note?.slice(0, 500) || request.reason,
        createdById: request.userId,
        approvedById: ctx.userId,
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
        reviewNote: body.note?.slice(0, 500) || null,
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        ledgerEntryId: entry.id,
      },
    })
    const approval = await resolveApprovalRequest({
      module: 'PAYROLL',
      type: request.type === 'WITHDRAWAL' ? 'WALLET_WITHDRAWAL' : 'WALLET_ADVANCE',
      entityId: request.id,
      status: 'APPROVED',
      actorUserId: ctx.userId,
      reason: body.note?.slice(0, 500) || 'Approved',
      tx,
    })
    if (!approval) {
      throw new Error('LINKAGE_BROKEN: pending approval missing for wallet request')
    }
    return { entry, request: updated, approval }
  }).catch(e => {
    logEvent('error', 'approval.approve.failed', {
      entityId: request.id,
      source: 'payroll_wallet',
      error: (e as Error).message,
    })
    throw e
  })

  deferAfterApprovalCommit('payroll.wallet_approve_notify', async () => {
    await notifyApprovalResolved(result.approval, ctx.userId, 'APPROVED', body.note?.slice(0, 500) || 'Approved')
    await notifyUser({
      userId: request.userId,
      businessId: request.businessId,
      type: 'WALLET_REQUEST_APPROVED',
      priority: 'HIGH',
      title: `${request.type} request approved`,
      message: `Approved amount: ৳ ${approvedAmount.toLocaleString('en-BD')}. Your wallet ledger was updated.`,
      actionUrl: '/portal',
    })
    await sendPayrollAlert({
      businessId: request.businessId,
      subject: `${request.type} request approved · ৳${approvedAmount.toLocaleString('en-BD')}`,
      title: 'Payroll approved',
      preview: `Approved amount: ৳${approvedAmount.toLocaleString('en-BD')}`,
      text: `${request.type} request for employee ${request.employeeId} was approved for ৳${approvedAmount.toLocaleString('en-BD')}.`,
      priority: 'HIGH',
      actionUrl: '/payroll',
      actionLabel: 'Open payroll',
      dedupeKey: `wallet-request-approved:${request.id}`,
      metadata: { requestId: request.id, employeeId: request.employeeId, approvedAmount },
    })
  })
  dispatchApprovalsUpdated()
  return NextResponse.json({ ok: true, ...result })
}
