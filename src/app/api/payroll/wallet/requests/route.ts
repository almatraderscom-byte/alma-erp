import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { sendPayrollAlert } from '@/lib/resend'
import { createApprovalRequest } from '@/lib/approvals'
import { queuePayrollWalletRequestAlert } from '@/lib/telegram-notification/payroll-alerts'
import { getPrimaryPaymentMethod, toPayoutSummary } from '@/lib/employee-payment-method'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('payroll.wallet.requests.list', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth
  const status = url.searchParams.get('status')

  const requests = await prisma.walletRequest.findMany({
    where: {
      businessId: { in: ctx.businessIds },
      ...(ctx.isAdmin ? {} : { userId: ctx.userId }),
      ...(status ? { status: status as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return apiDataSuccess({ requests })
})

export const POST = withApiRoute('payroll.wallet.requests.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    type?: 'ADVANCE' | 'WITHDRAWAL'
    amount?: number
    reason?: string
    business_id?: string
    employee_id?: string
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const type = body.type
  const amount = Number(body.amount || 0)
  const reason = String(body.reason || '').trim()
  if (type !== 'ADVANCE' && type !== 'WITHDRAWAL') {
    return apiFailure('invalid_request', 'type ADVANCE|WITHDRAWAL required', { status: 400 })
  }
  if (!amount || amount <= 0 || !reason) {
    return apiFailure('invalid_request', 'amount and reason required', { status: 400 })
  }

  const employeeId = ctx.isAdmin && body.employee_id ? body.employee_id.trim() : ctx.employeeId
  if (!employeeId) {
    if (ctx.isSystemOwner) {
      return apiFailure('forbidden', 'System owner accounts do not submit personal wallet requests. Select an employee to create a staff request.', { status: 403 })
    }
    return apiFailure('invalid_request', 'No employee profile linked to this account.', { status: 400 })
  }

  const businessId = ctx.businessIds[0]
  let paymentMethodId: string | null = null
  let payoutSnapshot = null as ReturnType<typeof toPayoutSummary> | null
  const preferred = await getPrimaryPaymentMethod(ctx.userId, businessId)
  if (preferred && preferred.status === 'ACTIVE') {
    paymentMethodId = preferred.id
    payoutSnapshot = toPayoutSummary(preferred, { reveal: false })
  }

  // Freeze-window idempotency guard: prevent duplicate PENDING wallet requests
  // when a client retries (mobile reconnect, double-tap, 502-from-cold-lambda).
  // Without this, two POSTs with the same fingerprint create two approvable
  // rows. We look for an exact-fingerprint PENDING row from the last 5 minutes;
  // the matching ApprovalRequest is then created idempotently below
  // (createApprovalRequest does its own findFirst-by-entityId), so an orphan
  // wallet row from an earlier partial failure is auto-healed by the retry.
  const idempotencyWindow = new Date(Date.now() - 5 * 60_000)
  const requestedDecimal = moneyDecimal(amount)
  const existingDuplicate = await prisma.walletRequest.findFirst({
    where: {
      userId: ctx.userId,
      employeeId,
      businessId,
      type,
      status: 'PENDING',
      requestedAmount: requestedDecimal,
      reason,
      createdAt: { gte: idempotencyWindow },
    },
    orderBy: { createdAt: 'desc' },
  })

  const request = existingDuplicate ?? await prisma.walletRequest.create({
    data: {
      userId: ctx.userId,
      employeeId,
      businessId,
      type,
      requestedAmount: requestedDecimal,
      reason,
      paymentMethodId,
    },
  })

  await createApprovalRequest({
    module: 'PAYROLL',
    type: type === 'WITHDRAWAL' ? 'WALLET_WITHDRAWAL' : 'WALLET_ADVANCE',
    businessId: request.businessId,
    entityId: request.id,
    requestedBy: ctx.userId,
    reason,
    priority: 'HIGH',
    actionUrl: '/payroll',
    title: `${type === 'WITHDRAWAL' ? 'Wallet withdrawal' : 'Wallet advance'} approval required`,
    message: `${type} request for employee ${employeeId}: ৳${amount.toLocaleString('en-BD')}. Reason: ${reason}`,
    payloadSnapshot: {
      requestId: request.id,
      employeeId,
      type,
      amount,
      businessId: request.businessId,
      payout: payoutSnapshot,
    },
  })

  const requester = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true },
  })
  await queuePayrollWalletRequestAlert({
    businessId: request.businessId,
    userId: ctx.userId,
    employeeId,
    employeeName: requester?.name,
    type,
    amount,
    reason,
    requestId: request.id,
    payout: payoutSnapshot,
  })

  await sendPayrollAlert({
    businessId: request.businessId,
    subject: `${type.toLowerCase()} request submitted · ৳${amount.toLocaleString('en-BD')}`,
    title: type === 'WITHDRAWAL' ? 'Withdrawal request' : 'Advance request',
    preview: reason,
    text: `${type} request submitted for employee ${employeeId}. Amount: ৳${amount.toLocaleString('en-BD')}. Reason: ${reason}`,
    priority: 'HIGH',
    actionUrl: '/payroll',
    actionLabel: 'Review wallet request',
    dedupeKey: `wallet-request:${request.id}`,
    metadata: { requestId: request.id, employeeId, businessId: request.businessId, type, amount },
  })

  return apiDataSuccess({ request, idempotentReplay: Boolean(existingDuplicate) })
})
