import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  attendanceDateFor,
  attendanceRecordDto,
  calculateEarlyCheckoutPenalty,
  notifyEarlyLeavePenalty,
  postEarlyLeavePenalty,
  workDurationMinutes,
} from '@/lib/attendance'
import { queueAttendanceCheckOutAlert } from '@/lib/telegram-notification/attendance-alerts'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { archiveOpenAssignmentsOnCheckout } from '@/lib/operational-tasks'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('attendance.check_out', async (req: NextRequest) => {
  const body = await parseJsonBody<{ business_id?: string }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not use employee attendance.', { status: 403 })
  }
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'Your user account is not linked to an HR employee ID.', { status: 400 })
  }

  const attendanceDate = attendanceDateFor()
  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      businessId_employeeId_attendanceDate: {
        businessId: ctx.businessIds[0],
        employeeId: ctx.employeeId,
        attendanceDate,
      },
    },
  })

  if (!existing) {
    return apiFailure('not_found', "Start work before ending today's attendance.", { status: 404 })
  }
  if (existing.checkOutAt) {
    return apiDataSuccess({
      duplicate: true,
      record: attendanceRecordDto({ ...existing, waiverRequests: [] }),
    })
  }

  const now = new Date()
  const totalWorkMinutes = workDurationMinutes(existing.checkInAt, now)

  const { earlyMinutes, earlyPenaltyAmount } = calculateEarlyCheckoutPenalty(now)
  const finalStatus = earlyPenaltyAmount > 0 ? 'EARLY_LEAVE' : 'COMPLETED'

  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutAt: now,
      totalWorkMinutes,
      status: finalStatus,
      earlyLeaveMinutes: earlyMinutes > 0 ? earlyMinutes : null,
      earlyLeavePenaltyAmount: earlyPenaltyAmount > 0 ? new Prisma.Decimal(earlyPenaltyAmount.toFixed(2)) : null,
    },
    include: { waiverRequests: true },
  })

  if (earlyPenaltyAmount > 0) {
    await postEarlyLeavePenalty(record, ctx.userId)
    void notifyEarlyLeavePenalty(record, ctx.userId).catch(() => {})
  }

  const setting = await getTelegramOpsSetting(ctx.businessIds[0])
  const isEarly = totalWorkMinutes < setting.earlyLeaveMinutes
  queueAttendanceCheckOutAlert({ ...record, checkOutAt: now }, { earlyLeave: isEarly })

  if (ctx.userId) {
    void archiveOpenAssignmentsOnCheckout(ctx.userId).catch(() => {})
  }

  return apiDataSuccess({ record: attendanceRecordDto(record) })
})
