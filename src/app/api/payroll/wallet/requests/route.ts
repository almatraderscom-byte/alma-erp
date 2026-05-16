import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { sendPayrollAlert } from '@/lib/resend'

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
