import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PENALTY_APPEAL_MODULE, PENALTY_APPEAL_TYPE, canReviewPenaltyAppeals, reviewPenaltyAppeal } from '@/lib/penalty-appeal'
import { resolveApprovalRequest } from '@/lib/approvals'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const PATCH = withApiRoute('attendance.waivers.review', async (req: NextRequest, ctx?: unknown) => {
  const { params } = (ctx || {}) as { params: { id: string } }
  const body = await parseJsonBody<{
    business_id?: string
    action?: 'APPROVE' | 'REJECT'
    approved_reduction_amount?: number
    admin_note?: string
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx: wallet } = auth

  if (!canReviewPenaltyAppeals(wallet.role)) {
    return apiFailure('forbidden', 'Only Admin or Super Admin can review penalty appeals.', { status: 403 })
  }

  const result = await reviewPenaltyAppeal({
    waiverId: params.id,
    businessId: wallet.businessIds[0],
    actorUserId: wallet.userId,
    action: body.action === 'REJECT' ? 'REJECT' : 'APPROVE',
    approvedReductionAmount: body.approved_reduction_amount,
    adminNote: body.admin_note,
    source: 'attendance',
  })

  if ('error' in result) {
    return apiFailure('review_failed', String(result.error || 'Review failed'), { status: result.status ?? 400 })
  }
  return apiDataSuccess(result as Record<string, unknown>)
})

export const DELETE = withApiRoute('attendance.waivers.cancel', async (req: NextRequest, ctx?: unknown) => {
  const { params } = (ctx || {}) as { params: { id: string } }
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx: wallet } = auth

  const waiver = await prisma.attendanceWaiverRequest.findFirst({
    where: { id: params.id, businessId: wallet.businessIds[0] },
  })
  if (!waiver) return apiFailure('not_found', 'Appeal not found.', { status: 404 })
  if (waiver.status !== 'PENDING') {
    return apiFailure('conflict', 'Only pending appeals can be cancelled.', { status: 409 })
  }
  if (!wallet.isAdmin && waiver.userId !== wallet.userId) {
    return apiFailure('forbidden', 'Forbidden', { status: 403 })
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
    actorUserId: wallet.userId,
    reason: 'Cancelled by requester',
    source: 'erp',
  })

  return apiDataSuccess({ waiver: updated })
})
