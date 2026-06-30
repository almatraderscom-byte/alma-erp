import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  defaultRequestedReduction,
  notifyPenaltyAppealSubmitted,
  parseRequestType,
  penaltyAppealDto,
  submitPenaltyAppeal,
  validateAttachmentDataUrl,
} from '@/lib/penalty-appeal'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('attendance.waivers.list', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const status = url.searchParams.get('status') || undefined
  const rows = await prisma.attendanceWaiverRequest.findMany({
    where: {
      businessId: ctx.businessIds[0],
      ...(ctx.isAdmin ? {} : { employeeId: ctx.employeeId }),
      ...(status ? { status: status as never } : {}),
    },
    include: {
      requester: { select: { name: true, email: true } },
      attendanceRecord: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return apiDataSuccess({
    waivers: rows.map(row => ({
      ...penaltyAppealDto(row),
      requesterName: row.requester.name,
      requesterEmail: row.requester.email,
      lateMinutes: row.attendanceRecord.lateMinutes,
      attendanceDate: row.attendanceRecord.attendanceDate.toISOString(),
    })),
  })
})

export const POST = withApiRoute('attendance.waivers.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    attendance_record_id?: string
    reason?: string
    request_type?: string
    requested_reduction_amount?: number
    attachment_data_url?: string
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not submit penalty appeals.', { status: 403 })
  }
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'Your user account is not linked to an HR employee ID.', { status: 400 })
  }

  const reason = String(body.reason || '').trim()
  if (!body.attendance_record_id || reason.length < 3) {
    return apiFailure('invalid_request', 'Attendance record and explanation (3+ characters) are required.', { status: 400 })
  }

  const attachmentCheck = validateAttachmentDataUrl(body.attachment_data_url)
  if (!attachmentCheck.ok) {
    return apiFailure('invalid_request', attachmentCheck.error, { status: 400 })
  }

  const record = await prisma.attendanceRecord.findFirst({
    where: {
      id: body.attendance_record_id,
      businessId: ctx.businessIds[0],
      employeeId: ctx.employeeId,
      userId: ctx.userId,
    },
  })
  if (!record) return apiFailure('not_found', 'Attendance record not found.', { status: 404 })
  // Appealable penalty = EVERY attendance fine: late check-in + early checkout
  // + owner-approved no-checkout fine. The reversal is penalty-agnostic, so one
  // appeal can cover all of them.
  const penalty =
    Number(record.penaltyAmount || 0) +
    Number(record.earlyLeavePenaltyAmount || 0) +
    Number(record.noCheckoutFineAmount || 0)
  if (penalty <= 0) {
    return apiFailure('invalid_request', 'এই উপস্থিতির রেকর্ডে কোনো জরিমানা নেই।', { status: 400 })
  }

  const requestType = parseRequestType(body.request_type)
  const requestedReduction = defaultRequestedReduction(penalty, requestType, body.requested_reduction_amount)

  const result = await submitPenaltyAppeal({
    attendanceRecordId: record.id,
    businessId: record.businessId,
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    userName: undefined,
    reason,
    requestType,
    requestedReduction,
    originalPenalty: penalty,
    attachmentDataUrl: attachmentCheck.value || null,
  })

  if ('error' in result) {
    return apiFailure('appeal_failed', result.error, { status: result.status })
  }

  if (result.repaired) {
    const waiverRow = await prisma.attendanceWaiverRequest.findUniqueOrThrow({
      where: { id: result.waiver.id },
      include: { requester: { select: { name: true } } },
    })
    try {
      await notifyPenaltyAppealSubmitted(waiverRow, {
        employeeId: ctx.employeeId,
        userId: ctx.userId,
        userName: waiverRow.requester.name,
      })
    } catch {
      // non-blocking
    }
  }

  return apiDataSuccess({
    waiver: result.waiver,
    repaired: result.repaired || false,
    reopened: result.reopened || false,
  })
})
