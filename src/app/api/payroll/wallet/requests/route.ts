import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { sendPayrollAlert } from '@/lib/resend'
import { createApprovalRequest } from '@/lib/approvals'
import { queuePayrollWalletRequestAlert } from '@/lib/telegram-notification/payroll-alerts'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  const status = url.searchParams.get('status')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  const requests = await prisma.walletRequest.findMany({
    where: {
      businessId: { in: ctx.businessIds },
      ...(ctx.isAdmin ? {} : { userId: ctx.userId }),
      ...(status ? { status: status as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ requests })
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    type?: 'ADVANCE' | 'WITHDRAWAL'
    amount?: number
    reason?: string
    business_id?: string
    employee_id?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error

  const type = body.type
  const amount = Number(body.amount || 0)
  const reason = String(body.reason || '').trim()
  if (type !== 'ADVANCE' && type !== 'WITHDRAWAL') {
    return NextResponse.json({ error: 'type ADVANCE|WITHDRAWAL required' }, { status: 400 })
  }
  if (!amount || amount <= 0 || !reason) {
    return NextResponse.json({ error: 'amount and reason required' }, { status: 400 })
  }

  const employeeId = ctx.isAdmin && body.employee_id ? body.employee_id.trim() : ctx.employeeId
  if (!employeeId) {
    if (ctx.isSystemOwner) {
      return NextResponse.json({ error: 'System owner accounts do not submit personal wallet requests. Select an employee to create a staff request.' }, { status: 403 })
    }
    return NextResponse.json({ error: 'No employee profile linked to this account.' }, { status: 400 })
  }

  const request = await prisma.walletRequest.create({
    data: {
      userId: ctx.userId,
      employeeId,
      businessId: ctx.businessIds[0],
      type,
      requestedAmount: moneyDecimal(amount),
      reason,
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
    payloadSnapshot: { requestId: request.id, employeeId, type, amount, businessId: request.businessId },
  })

  const requester = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true },
  })
  queuePayrollWalletRequestAlert({
    businessId: request.businessId,
    userId: ctx.userId,
    employeeId,
    employeeName: requester?.name,
    type,
    amount,
    reason,
    requestId: request.id,
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

  return NextResponse.json({ ok: true, request })
}
