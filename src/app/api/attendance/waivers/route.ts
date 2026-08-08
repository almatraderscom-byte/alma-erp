import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  defaultRequestedReduction,
  parseRequestType,
  penaltyAppealDto,
  submitPenaltyAppeal,
  validateAttachmentDataUrl,
} from '@/lib/penalty-appeal'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'
import { resolvePenaltyTarget } from '@/lib/penalty-appeal-policy'
import { resolveAttendancePenaltyTarget } from '@/lib/attendance-penalty-target'

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
      reviewer: { select: { name: true } },
      attendanceRecord: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return apiDataSuccess({
    waivers: rows.map(row => {
      const target = resolveAttendancePenaltyTarget(
        row.attendanceRecord,
        row.penaltyLedgerEntryId,
        row.originalPenaltyAmount,
      )
      return {
        ...penaltyAppealDto(row),
        requesterName: row.requester.name,
        requesterEmail: row.requester.email,
        reviewerName: row.reviewer?.name || null,
        penaltyKind: target?.kind || 'UNKNOWN',
        penaltyMinutes: target?.minutes || 0,
        lateMinutes: row.attendanceRecord.lateMinutes,
        attendanceDate: row.attendanceRecord.attendanceDate.toISOString(),
      }
    }),
  })
})

export const POST = withApiRoute('attendance.waivers.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    attendance_record_id?: string
    penalty_ledger_entry_id?: string
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
  const target = resolvePenaltyTarget([
    record.penaltyLedgerEntryId,
    record.earlyLeavePenaltyLedgerEntryId,
    record.noCheckoutFineLedgerEntryId,
  ], body.penalty_ledger_entry_id)

  if (!target.ok && target.reason === 'MISSING_SELECTION') {
    return apiFailure(
      'invalid_request',
      'কোন জরিমানার আপিল করছেন তা নির্বাচন করুন। পেজটি রিফ্রেশ করে নির্দিষ্ট জরিমানার “আপিল করুন” চাপুন।',
      { status: 400 },
    )
  }
  if (!target.ok) {
    return apiFailure('not_found', 'এই attendance record-এ নির্দিষ্ট জরিমানাটি পাওয়া যায়নি।', { status: 404 })
  }
  const penaltyLedgerEntryId = target.penaltyLedgerEntryId

  // The wallet ledger is authoritative. Never trust the amount displayed or
  // posted by a client; this prevents a ৳500 no-checkout fine being submitted
  // as the day's ৳50 late penalty (or vice versa).
  const penaltyEntry = await prisma.employeeLedgerEntry.findFirst({
    where: {
      id: penaltyLedgerEntryId,
      employeeId: ctx.employeeId,
      businessId: record.businessId,
      type: 'PENALTY',
      isArchived: false,
    },
    select: { amount: true },
  })
  if (!penaltyEntry) {
    return apiFailure('not_found', 'জরিমানার wallet entry পাওয়া যায়নি।', { status: 404 })
  }
  const penalty = Math.abs(Number(penaltyEntry.amount || 0))
  if (penalty <= 0) {
    return apiFailure('invalid_request', 'এই উপস্থিতির রেকর্ডে কোনো জরিমানা নেই।', { status: 400 })
  }

  const requestType = parseRequestType(body.request_type)
  // Preserve an explicitly supplied amount so the service can reject zero or
  // over-limit input before immutable once-only appeal history is created.
  // Defaults apply only when an amount was genuinely omitted.
  const requestedReduction = body.requested_reduction_amount == null
    ? defaultRequestedReduction(penalty, requestType)
    : Number(body.requested_reduction_amount)

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
    penaltyLedgerEntryId,
    attachmentDataUrl: attachmentCheck.value || null,
  })

  if ('error' in result) {
    return apiFailure('appeal_failed', result.error, { status: result.status })
  }

  return apiDataSuccess({
    waiver: result.waiver,
  })
})
