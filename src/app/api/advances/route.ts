import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt, forbidViewerWrite, validateMutationBusiness } from '@/lib/api-guards'
import { parseBusinessAccess } from '@/lib/business-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { sendPayrollAlert } from '@/lib/resend'
import { notifyRoles, notifyUser } from '@/lib/notifications'
import { NOTIFY_ROLES } from '@/lib/notification-routing'
import { enqueuePayrollAdvanceAlertSms } from '@/services/sms/events'
import { createApprovalRequest } from '@/lib/approvals'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = normalizeAlmaRole(token.role as string)
  const url = new URL(req.url)
  const scope = url.searchParams.get('scope')

  if (scope === 'pending' && ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role)) {
    const allowedBiz = parseBusinessAccess(token.businessAccess as string)
    const where =
      allowedBiz.length === 1
        ? { status: 'PENDING' as const, businessId: allowedBiz[0] }
        : { status: 'PENDING' as const }
    const pending = await prisma.salaryAdvanceRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true, employeeIdGas: true } } },
    })
    return NextResponse.json({ advances: pending })
  }

  const mine = await prisma.salaryAdvanceRequest.findMany({
    where: { userId: token.sub },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ advances: mine })
}

export async function POST(req: NextRequest) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied

  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = (await req.json()) as { amount?: number; reason?: string; business_id?: string }
    const bizErr = await validateMutationBusiness(req, body.business_id || 'ALMA_LIFESTYLE')
    if (bizErr) return bizErr

    const amount = Number(body.amount)
    const reason = String(body.reason || '').trim()
    if (!amount || amount <= 0 || !reason) {
      return NextResponse.json({ error: 'amount and reason required' }, { status: 400 })
    }

    const row = await prisma.salaryAdvanceRequest.create({
      data: {
        userId: token.sub,
        businessId: body.business_id || 'ALMA_LIFESTYLE',
        amount,
        reason,
      },
    })

    enqueuePayrollAdvanceAlertSms({ businessId: row.businessId, requestId: row.id })
    await createApprovalRequest({
      module: 'PAYROLL',
      type: 'SALARY_ADVANCE',
      businessId: row.businessId,
      entityId: row.id,
      requestedBy: token.sub,
      reason,
      priority: 'HIGH',
      actionUrl: '/payroll',
      title: 'Salary advance approval required',
      message: `Advance request for ৳${amount.toLocaleString('en-BD')}: ${reason}`,
      payloadSnapshot: { amount, businessId: row.businessId, requestId: row.id },
    })
    void Promise.all([
      // Approvers per the role matrix (now includes ADMIN — audit gap).
      notifyRoles(NOTIFY_ROLES.advanceRequested, {
        businessId: row.businessId,
        type: 'PAYROLL_ALERT',
        priority: 'HIGH',
        title: 'Salary advance request',
        message: `Advance request for ৳${amount.toLocaleString('en-BD')}: ${reason}`,
        actionUrl: '/payroll',
      }),
      // Confirmation bell for the requester — they previously heard nothing
      // until an approval/rejection arrived.
      notifyUser({
        userId: token.sub,
        businessId: row.businessId,
        type: 'PAYROLL_ALERT',
        priority: 'NORMAL',
        title: 'Advance request submitted',
        message: `আপনার ৳${amount.toLocaleString('en-BD')} অগ্রিম বেতনের আবেদন জমা হয়েছে — অনুমোদনের অপেক্ষায়।`,
        actionUrl: '/portal/wallet',
      }),
      sendPayrollAlert({
      businessId: row.businessId,
      subject: `Salary advance requested · ৳${amount.toLocaleString('en-BD')}`,
      title: 'Salary advance request',
      preview: reason,
      text: `A salary advance request was submitted for ৳${amount.toLocaleString('en-BD')}. Reason: ${reason}`,
      priority: 'HIGH',
      actionUrl: '/payroll',
      actionLabel: 'Review request',
      dedupeKey: `salary-advance-request:${row.id}`,
      metadata: { requestId: row.id, businessId: row.businessId, amount },
      }),
    ]).catch(() => {})

    return NextResponse.json({ ok: true, id: row.id })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
