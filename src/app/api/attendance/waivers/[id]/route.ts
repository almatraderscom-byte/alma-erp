import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { PENALTY_APPEAL_MODULE, PENALTY_APPEAL_TYPE, canReviewPenaltyAppeals, reviewPenaltyAppeal } from '@/lib/penalty-appeal'
import { resolveApprovalRequest } from '@/lib/approvals'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    action?: 'APPROVE' | 'REJECT'
    approved_reduction_amount?: number
    admin_note?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!canReviewPenaltyAppeals(ctx.role)) {
    return NextResponse.json({ error: 'Only Admin or Super Admin can review penalty appeals.' }, { status: 403 })
  }

  const result = await reviewPenaltyAppeal({
    waiverId: params.id,
    businessId: ctx.businessIds[0],
    actorUserId: ctx.userId,
    action: body.action === 'REJECT' ? 'REJECT' : 'APPROVE',
    approvedReductionAmount: body.approved_reduction_amount,
    adminNote: body.admin_note,
    source: 'attendance',
  })

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error

  const waiver = await prisma.attendanceWaiverRequest.findFirst({
    where: { id: params.id, businessId: ctx.businessIds[0] },
  })
  if (!waiver) return NextResponse.json({ error: 'Appeal not found.' }, { status: 404 })
  if (waiver.status !== 'PENDING') {
    return NextResponse.json({ error: 'Only pending appeals can be cancelled.' }, { status: 409 })
  }
  if (!ctx.isAdmin && waiver.userId !== ctx.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updated = await prisma.attendanceWaiverRequest.update({
    where: { id: waiver.id },
    data: { status: 'CANCELLED' },
  })

  await resolveApprovalRequest({
    module: PENALTY_APPEAL_MODULE,
    type: PENALTY_APPEAL_TYPE,
    entityId: waiver.id,
    status: 'REJECTED',
    actorUserId: ctx.userId,
    reason: 'Cancelled by requester',
    source: 'erp',
  })

  return NextResponse.json({ ok: true, waiver: updated })
}
